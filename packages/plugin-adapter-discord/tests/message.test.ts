import { describe, expect, it } from 'vitest'
import { buildContent, CONTENT_LIMIT, decodeMessage, guildInfo, memberRole, parseContent } from '../src/message'
import { intentsOf } from '../src'

// Payload shapes follow the Discord API docs (discord.com/developers/docs).
describe('parseContent', () => {
  it('reads user mentions and custom emoji', () => {
    expect(parseContent('<@!1> hi <:wave:99> <@&5>', [{ id: '1', username: 'ann', global_name: 'Ann' }])).toEqual([
      { type: 'at', data: { qq: '1', name: 'Ann' } },
      { type: 'text', data: { text: ' hi :wave: <@&5>' } },
    ])
  })
})

describe('decodeMessage', () => {
  const guild = guildInfo({ id: 'g', name: 'Club', owner_id: '10', roles: [{ id: 'r-admin', permissions: '8' }, { id: 'r-mod', permissions: '1024' }] })

  it('reads a guild reply with an attachment and the sender role', () => {
    const message = decodeMessage({
      id: 'm1', type: 19, channel_id: 'c1', guild_id: 'g', timestamp: '2024-01-01T00:00:00.000Z',
      author: { id: '20', username: 'bo' }, member: { nick: 'Bobby', roles: ['r-admin'] },
      content: 'see', message_reference: { message_id: 'm0' }, referenced_message: { id: 'm0' },
      attachments: [{ url: 'https://cdn.discordapp.com/a.png', filename: 'a.png', content_type: 'image/png', size: 3 }],
    }, { guild, channelName: 'general' })!
    expect(message).toMatchObject({ messageId: 'm1', channel: { type: 'group', id: 'c1', name: 'general' }, user: { id: '20', name: 'Bobby', role: 'admin' } })
    expect(message.segments).toEqual([
      { type: 'reply', data: { id: 'm0' } },
      { type: 'text', data: { text: 'see' } },
      { type: 'image', data: { file: 'https://cdn.discordapp.com/a.png', url: 'https://cdn.discordapp.com/a.png', name: 'a.png', size: 3 } },
    ])
  })

  it('reads a DM as a private chat with the author', () => {
    expect(decodeMessage({ id: 'm2', channel_id: 'dm1', author: { id: '30', username: 'cy' }, content: 'yo' })!.channel).toEqual({ type: 'private', id: '30', name: 'cy' })
  })

  it('tells owners, administrators and members apart', () => {
    expect(memberRole(guild, '10', [])).toBe('owner')
    expect(memberRole(guild, '11', ['r-mod'])).toBe('member')
    expect(memberRole(undefined, '11', [])).toBeUndefined()
  })
})

describe('buildContent', () => {
  it('writes mentions and splits long text', () => {
    expect(buildContent([{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: ' hi' } }, { type: 'at', data: { qq: 'all' } }])).toEqual({ chunks: ['<@1> hi@everyone'], everyone: true })
    const long = `${'word '.repeat(500)}`
    const { chunks } = buildContent([{ type: 'text', data: { text: long } }])
    expect(chunks.length).toBe(2)
    expect(chunks.every((chunk) => chunk.length <= CONTENT_LIMIT)).toBe(true)
    expect(chunks.join('')).toBe(long)
  })
})

describe('intents', () => {
  it('asks for message content and members only when set', () => {
    expect(intentsOf({ messageContent: true, members: false }) & (1 << 15)).toBeTruthy()
    expect(intentsOf({ messageContent: false, members: false }) & (1 << 15)).toBe(0)
    expect(intentsOf({ messageContent: false, members: true }) & (1 << 1)).toBeTruthy()
  })
})
