import { createCipheriv } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildContent, decodeEvent, decodeMessage, escapeKMarkdown, parseKMarkdown } from '../src/message'
import { decryptWebhook, readWebhookBody } from '../src'

// Event shapes follow the KOOK developer docs (developer.kookapp.cn/doc/event).
describe('parseKMarkdown', () => {
  it('reads mentions, emoji and escapes', () => {
    expect(parseKMarkdown('(met)123(met) hi \\*there\\* (emj)smile(emj)[1/abc] (met)here(met)', { escaped: true, names: { 123: 'Ann#0001' } })).toEqual([
      { type: 'at', data: { qq: '123', name: 'Ann#0001' } },
      { type: 'text', data: { text: ' hi *there* :smile: ' } },
      { type: 'at', data: { qq: 'all' } },
    ])
  })
})

describe('decodeMessage', () => {
  it('reads a channel message with a quote', () => {
    const message = decodeMessage({
      channel_type: 'GROUP', type: 9, target_id: 'c1', author_id: 'u1', content: '(met)bot(met) /help', msg_id: 'm1', msg_timestamp: 1_700_000_000_000,
      extra: { type: 9, guild_id: 'g1', channel_name: 'chat', author: { id: 'u1', username: 'ann', nickname: 'Annie' }, quote: { id: 'm0' }, kmarkdown: { mention_part: [] } },
    })!
    expect(message).toMatchObject({ messageId: 'm1', channel: { type: 'group', id: 'c1', name: 'chat' }, user: { id: 'u1', name: 'Annie' }, timestamp: 1_700_000_000_000 })
    expect(message.segments).toEqual([{ type: 'reply', data: { id: 'm0' } }, { type: 'at', data: { qq: 'bot' } }, { type: 'text', data: { text: ' /help' } }])
  })

  it('reads a private picture', () => {
    const message = decodeMessage({ channel_type: 'PERSON', type: 2, target_id: 'bot', author_id: 'u2', content: 'https://img.kookapp.cn/a.png', msg_id: 'm2', extra: { author: { username: 'bo' }, attachments: { type: 'image', url: 'https://img.kookapp.cn/a.png', name: 'a.png' } } })!
    expect(message.channel).toEqual({ type: 'private', id: 'u2', name: 'bo' })
    expect(message.segments).toEqual([{ type: 'image', data: { file: 'https://img.kookapp.cn/a.png', url: 'https://img.kookapp.cn/a.png', name: 'a.png' } }])
  })
})

describe('decodeEvent', () => {
  it('names system events', () => {
    const event = decodeEvent({ channel_type: 'GROUP', type: 255, target_id: 'g1', extra: { type: 'added_reaction', body: { channel_id: 'c1', user_id: 'u1', msg_id: 'm1' } } })
    expect(event).toMatchObject({ name: 'added_reaction', channel: { type: 'group', id: 'c1' }, user: { id: 'u1' }, data: { guild_id: 'g1' } })
  })
})

describe('buildContent', () => {
  it('sends plain text unless someone is mentioned', () => {
    expect(buildContent([{ type: 'text', data: { text: 'a*b' } }])).toEqual({ content: 'a*b', type: 1 })
    expect(buildContent([{ type: 'at', data: { qq: '9' } }, { type: 'text', data: { text: ' a*b' } }])).toEqual({ content: '(met)9(met) a\\*b', type: 9 })
    expect(escapeKMarkdown('(x)')).toBe('\\(x\\)')
  })
})

describe('webhook bodies', () => {
  const key = 'encrypt-key'
  const encrypt = (text: string) => {
    const iv = 'abcdefghijklmnop'
    const keyBytes = Buffer.alloc(32)
    Buffer.from(key).copy(keyBytes)
    const cipher = createCipheriv('aes-256-cbc', keyBytes, Buffer.from(iv))
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64')
    return Buffer.from(iv + encrypted).toString('base64')
  }

  it('decrypts and inflates what KOOK posts', () => {
    const event = { s: 0, d: { type: 1, verify_token: 'v' }, sn: 1 }
    expect(decryptWebhook(encrypt(JSON.stringify(event)), key)).toBe(JSON.stringify(event))
    const body = deflateSync(Buffer.from(JSON.stringify({ encrypt: encrypt(JSON.stringify(event)) })))
    expect(readWebhookBody(body, key)).toEqual(event)
    expect(readWebhookBody(Buffer.from(JSON.stringify(event)), '')).toEqual(event)
  })
})
