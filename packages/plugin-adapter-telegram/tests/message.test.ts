import { describe, expect, it } from 'vitest'
import { buildText, decodeEvents, decodeMessage, parseText } from '../src/message'
import { webhookSecret } from '../src'

// Update shapes follow the Telegram Bot API reference (core.telegram.org/bots/api).
const self = { id: '777', username: 'MushinBot', name: 'Mushin' }

describe('parseText', () => {
  it('turns mentions of the bot and text mentions into at segments', () => {
    const text = 'hi @MushinBot and Ann!'
    const segments = parseText(text, [
      { type: 'mention', offset: 3, length: 10 },
      { type: 'text_mention', offset: 18, length: 3, user: { id: 42, first_name: 'Ann' } },
    ], self)
    expect(segments).toEqual([
      { type: 'text', data: { text: 'hi ' } },
      { type: 'at', data: { qq: '777', name: 'Mushin' } },
      { type: 'text', data: { text: ' and ' } },
      { type: 'at', data: { qq: '42', name: 'Ann' } },
      { type: 'text', data: { text: '!' } },
    ])
  })

  it('drops the bot name from commands and keeps other mentions as text', () => {
    expect(parseText('/help@MushinBot now', [{ type: 'bot_command', offset: 0, length: 15 }], self)).toEqual([{ type: 'text', data: { text: '/help now' } }])
    expect(parseText('@someone', [{ type: 'mention', offset: 0, length: 8 }], self)).toEqual([{ type: 'text', data: { text: '@someone' } }])
  })

  it('counts offsets in UTF-16 units', () => {
    const segments = parseText('😀 @MushinBot', [{ type: 'mention', offset: 3, length: 10 }], self)
    expect(segments[1]).toEqual({ type: 'at', data: { qq: '777', name: 'Mushin' } })
  })
})

describe('decodeMessage', () => {
  it('reads a group photo with a caption and a reply', () => {
    const message = decodeMessage({
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: -100123, type: 'supergroup', title: 'Fans' },
      from: { id: 42, first_name: 'Ann', last_name: 'Lee' },
      photo: [{ file_id: 'small', width: 90, height: 90 }, { file_id: 'big', width: 800, height: 600, file_size: 5000 }],
      caption: 'look',
      reply_to_message: { message_id: 9 },
    }, self)!
    expect(message).toMatchObject({ messageId: '10', channel: { type: 'group', id: '-100123', name: 'Fans' }, user: { id: '42', name: 'Ann Lee' }, timestamp: 1_700_000_000_000 })
    expect(message.segments).toEqual([
      { type: 'reply', data: { id: '9' } },
      { type: 'image', data: { file: 'big', file_id: 'big', size: 5000 } },
      { type: 'text', data: { text: 'look' } },
    ])
  })

  it('does not take a forum topic for a quote', () => {
    const message = decodeMessage({ message_id: 5, chat: { id: -1, type: 'supergroup' }, from: { id: 1 }, text: 'x', is_topic_message: true, message_thread_id: 3, reply_to_message: { message_id: 3 } }, self)!
    expect(message.segments).toEqual([{ type: 'text', data: { text: 'x' } }])
  })

  it('leaves service messages to events', () => {
    const update = { message: { message_id: 1, chat: { id: -1, type: 'group', title: 'G' }, from: { id: 1 }, new_chat_members: [{ id: 5, first_name: 'Bo' }] } }
    expect(decodeMessage(update.message, self)).toBeUndefined()
    expect(decodeEvents(update)).toMatchObject([{ name: 'new_chat_members', channel: { type: 'group', id: '-1' }, user: { id: '5', name: 'Bo' } }])
  })
})

describe('decodeEvents', () => {
  it('names button presses and membership changes', () => {
    expect(decodeEvents({ callback_query: { id: 'q', from: { id: 42, first_name: 'Ann' }, data: 'yes', message: { chat: { id: 42, type: 'private', first_name: 'Ann' } } } }))
      .toMatchObject([{ name: 'callback_query', channel: { type: 'private', id: '42' }, user: { id: '42' } }])
    expect(decodeEvents({ my_chat_member: { chat: { id: -2, type: 'group' }, from: { id: 1 }, new_chat_member: { user: { id: 777 }, status: 'member' } } }))
      .toMatchObject([{ name: 'my_chat_member', user: { id: '777' } }])
  })
})

describe('buildText', () => {
  it('links mentions with text_mention entities', () => {
    expect(buildText([{ type: 'text', data: { text: '😀 ' } }, { type: 'at', data: { qq: '42', name: 'Ann' } }, { type: 'text', data: { text: ' hi' } }]))
      .toEqual({ text: '😀 @Ann hi', entities: [{ type: 'text_mention', offset: 3, length: 4, user: { id: 42 } }] })
  })
})

describe('webhookSecret', () => {
  it('is a stable token Telegram accepts', () => {
    expect(webhookSecret('1:abc')).toBe(webhookSecret('1:abc'))
    expect(webhookSecret('1:abc')).not.toBe(webhookSecret('1:abd'))
    expect(webhookSecret('1:abc')).toMatch(/^[A-Za-z0-9_-]{1,256}$/)
  })
})
