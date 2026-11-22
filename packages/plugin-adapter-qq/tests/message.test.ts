import { sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { chatKind, decodeEvent, decodeMessage, parseContent, splitOutgoing } from '../src/message'
import { intentsOf } from '../src'
import { signChallenge, verifyRequest, webhookKey } from '../src/signature'

// Payload shapes follow the QQ Bot OpenAPI docs (bot.q.qq.com/wiki/develop/api-v2).
describe('decodeMessage', () => {
  it('reads a group @-message and puts a mention of the bot first', () => {
    const message = decodeMessage('GROUP_AT_MESSAGE_CREATE', {
      id: 'ROBOT1.0_abc',
      author: { member_openid: 'E4F4AEA33253A2797FB897C50B81D7ED' },
      content: ' /help me',
      group_openid: 'C9F778FA4D5A7F7FC4A3B0D3B5E3B1D1',
      timestamp: '2024-01-02T03:04:05+08:00',
    }, '1234')!
    expect(message.channel).toEqual({ type: 'group', id: 'C9F778FA4D5A7F7FC4A3B0D3B5E3B1D1' })
    expect(message.user.id).toBe('E4F4AEA33253A2797FB897C50B81D7ED')
    expect(message.segments).toEqual([{ type: 'at', data: { qq: '1234' } }, { type: 'text', data: { text: '/help me' } }])
    expect(message.messageId).toBe('ROBOT1.0_abc')
    expect(message.timestamp).toBe(Date.parse('2024-01-02T03:04:05+08:00'))
  })

  it('reads a C2C message with an image', () => {
    const message = decodeMessage('C2C_MESSAGE_CREATE', {
      id: 'm2',
      author: { user_openid: 'ABCDEF0123' },
      content: 'look',
      attachments: [{ content_type: 'image/jpeg', url: 'multimedia.nt.qq.com.cn/download?id=1', filename: 'a.jpg' }],
    })!
    expect(message.channel).toEqual({ type: 'private', id: 'ABCDEF0123' })
    expect(message.segments[1]).toMatchObject({ type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/download?id=1', name: 'a.jpg' } })
  })

  it('reads guild mentions, faces, roles and DMs', () => {
    const message = decodeMessage('AT_MESSAGE_CREATE', {
      id: 'g1',
      channel_id: '100',
      guild_id: '200',
      author: { id: '300', username: 'Ann' },
      member: { nick: 'Annie', roles: ['4'] },
      content: '<@!999> hi &amp; bye<emoji:4>',
      mentions: [{ id: '999', username: 'Bot' }],
    })!
    expect(message.channel).toEqual({ type: 'group', id: '100' })
    expect(message.user).toEqual({ id: '300', name: 'Annie', role: 'owner' })
    expect(message.segments).toEqual([
      { type: 'at', data: { qq: '999', name: 'Bot' } },
      { type: 'text', data: { text: 'hi & bye' } },
      { type: 'face', data: { id: '4' } },
    ])
    const dm = decodeMessage('DIRECT_MESSAGE_CREATE', { id: 'd1', guild_id: '555', channel_id: '1', author: { id: '300', username: 'Ann' }, content: 'yo' })!
    expect(dm.channel).toEqual({ type: 'private', id: '300', name: 'Ann' })
    expect(dm.dmsGuild).toBe('555')
  })

  it('ignores events that are not messages', () => {
    expect(decodeMessage('GROUP_ADD_ROBOT', { group_openid: 'X' })).toBeUndefined()
  })
})

describe('decodeEvent', () => {
  it('names events and finds the chat', () => {
    const event = decodeEvent('GROUP_ADD_ROBOT', { group_openid: 'G1', op_member_openid: 'U1', timestamp: 1 }, 'GROUP_ADD_ROBOT:1')
    expect(event).toMatchObject({ name: 'group_add_robot', channel: { type: 'group', id: 'G1' }, user: { id: 'U1' }, data: { event_id: 'GROUP_ADD_ROBOT:1' } })
    expect(decodeEvent('FRIEND_ADD', { openid: 'U2' })).toMatchObject({ name: 'friend_add', channel: { type: 'private', id: 'U2' } })
  })
})

describe('outgoing messages', () => {
  it('tells chats apart by the shape of the id', () => {
    expect(chatKind({ type: 'group', id: 'C9F778FA' })).toBe('group')
    expect(chatKind({ type: 'group', id: '12345' })).toBe('channel')
    expect(chatKind({ type: 'private', id: 'ABCDEF' })).toBe('c2c')
    expect(chatKind({ type: 'private', id: '300' })).toBe('dms')
  })

  it('writes mentions in guilds and names elsewhere', () => {
    const segments = [{ type: 'reply', data: { id: 'm1' } }, { type: 'at', data: { qq: '300', name: 'Ann' } }, { type: 'text', data: { text: ' hi' } }, { type: 'image', data: { file: 'https://x/a.png' } }]
    expect(splitOutgoing(segments, 'channel')).toMatchObject({ text: '<@300> hi', reply: 'm1', media: [segments[3]] })
    expect(splitOutgoing(segments, 'group').text).toBe('@Ann hi')
  })

  it('round-trips parsed text', () => {
    expect(parseContent('a<@1>b')).toEqual([{ type: 'text', data: { text: 'a' } }, { type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: 'b' } }])
  })
})

describe('intents', () => {
  it('asks for group, guild and private-bot events as configured', () => {
    expect(intentsOf({ groups: true, guilds: false, allGuildMessages: false })).toBe(1 << 25)
    expect(intentsOf({ groups: false, guilds: true, allGuildMessages: false })).toBe((1 << 0) | (1 << 1) | (1 << 12) | (1 << 30))
    expect(intentsOf({ groups: false, guilds: true, allGuildMessages: true }) & (1 << 9)).toBeTruthy()
  })
})

describe('webhook signatures', () => {
  const key = webhookKey('naOC0ocQE3shWLAfffVLB1rhYPG7')

  it('signs the address check with a key seeded from the repeated secret', () => {
    const signature = signChallenge(key, '1725442341', 'Arq0D5A61EgUu4OxUvOp')
    expect(signature).toMatch(/^[0-9a-f]{128}$/)
    // A short secret is repeated to 32 bytes: "abc" gives the same key as "abcabc".
    expect(signChallenge(webhookKey('abc'), '1', 't')).toBe(signChallenge(webhookKey('abcabc'), '1', 't'))
  })

  it('accepts requests QQ signed and refuses others', () => {
    const body = '{"op":0}'
    const signature = sign(null, Buffer.from(`1700000000${body}`), key).toString('hex')
    expect(verifyRequest(key, '1700000000', body, signature)).toBe(true)
    expect(verifyRequest(key, '1700000001', body, signature)).toBe(false)
    expect(verifyRequest(key, '1700000000', body, null)).toBe(false)
    expect(verifyRequest(webhookKey('other-secret-1234567890'), '1700000000', body, signature)).toBe(false)
  })
})
