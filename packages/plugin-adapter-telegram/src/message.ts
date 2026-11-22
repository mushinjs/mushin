import { type ChannelInfo, type Segment, seg, type UserInfo } from '@mushinjs/core'
import type { BotEvent, IncomingMessage } from '@mushinjs/plugin-bots'

/** Segment types this adapter sends. */
export const TELEGRAM_SEGMENTS = ['text', 'at', 'image', 'record', 'video', 'file', 'reply']

export interface SelfInfo {
  id: string
  username?: string
  name?: string
}

/** A person's display name: first and last name, as Telegram shows it. */
export function nameOf(user: any): string | undefined {
  if (!user) return
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ')
  return name || user.username || user.title || undefined
}

export function channelOf(chat: any): ChannelInfo {
  if (chat?.type === 'private') {
    const name = nameOf(chat)
    return { type: 'private', id: String(chat.id), ...(name ? { name } : {}) }
  }
  return { type: 'group', id: String(chat?.id), ...(chat?.title ? { name: String(chat.title) } : {}) }
}

export function userOf(user: any): UserInfo {
  const name = nameOf(user)
  return { id: String(user?.id ?? ''), ...(name ? { name } : {}) }
}

/**
 * Text with its entities as segments: a `text_mention` (a person without a username) and an
 * `@username` mention of the bot become `at` segments, and `/command@ThisBot` loses the bot's
 * name so commands match. Entity offsets count UTF-16 units, as JavaScript strings do.
 */
export function parseText(text: string, entities: any[] | undefined, self: SelfInfo): Segment[] {
  const segments: Segment[] = []
  const pushText = (value: string) => {
    if (!value) return
    const last = segments.at(-1)
    if (last?.type === 'text') last.data.text += value
    else segments.push(seg.text(value))
  }
  const sorted = [...(entities ?? [])].sort((a, b) => a.offset - b.offset)
  let cursor = 0
  const own = self.username?.toLowerCase()
  for (const entity of sorted) {
    if (entity.offset < cursor) continue
    const part = text.slice(entity.offset, entity.offset + entity.length)
    if (entity.type === 'text_mention' && entity.user) {
      pushText(text.slice(cursor, entity.offset))
      segments.push(seg.at(String(entity.user.id), nameOf(entity.user)))
    } else if (entity.type === 'mention' && own && part.slice(1).toLowerCase() === own) {
      pushText(text.slice(cursor, entity.offset))
      segments.push(seg.at(self.id, self.name ?? self.username))
    } else if (entity.type === 'bot_command' && own && part.toLowerCase().endsWith(`@${own}`)) {
      pushText(text.slice(cursor, entity.offset))
      pushText(part.slice(0, part.length - own.length - 1))
    } else continue
    cursor = entity.offset + entity.length
  }
  pushText(text.slice(cursor))
  return segments
}

/** Pictures, voice, video, files and stickers as segments, pointing at their `file_id`. */
export function parseMedia(message: any): Segment[] {
  const media = (type: string, file: any, extra: Record<string, any> = {}): Segment => ({
    type,
    data: { file: file.file_id, file_id: file.file_id, ...(file.file_size ? { size: file.file_size } : {}), ...(file.file_name ? { name: file.file_name } : {}), ...extra },
  })
  if (Array.isArray(message.photo) && message.photo.length) {
    const largest = message.photo.reduce((best: any, item: any) => ((item.width ?? 0) * (item.height ?? 0) > (best.width ?? 0) * (best.height ?? 0) ? item : best))
    return [media('image', largest)]
  }
  if (message.sticker) return [media('image', message.sticker, { sticker: true, ...(message.sticker.emoji ? { summary: message.sticker.emoji } : {}) })]
  if (message.animation) return [media('video', message.animation, { animation: true })]
  if (message.video) return [media('video', message.video)]
  if (message.video_note) return [media('video', message.video_note)]
  if (message.voice) return [media('record', message.voice)]
  if (message.audio) return [media('record', message.audio)]
  if (message.document) return [media('file', message.document)]
  return []
}

/** A message with text or media as an incoming message; service messages give undefined. */
export function decodeMessage(message: any, self: SelfInfo): IncomingMessage | undefined {
  if (!message?.chat) return
  const segments: Segment[] = [...parseMedia(message)]
  const text = message.text ?? message.caption
  if (typeof text === 'string') segments.push(...parseText(text, message.entities ?? message.caption_entities, self))
  if (!segments.length) return
  const reply = message.reply_to_message
  // In a forum, every message "replies" to the topic's first message; that is not a quote.
  if (reply?.message_id && !(message.is_topic_message && reply.message_id === message.message_thread_id)) {
    segments.unshift(seg.reply(String(reply.message_id)))
  }
  const sender = message.from ?? message.sender_chat
  return {
    messageId: String(message.message_id),
    channel: channelOf(message.chat),
    user: userOf(sender),
    segments,
    timestamp: typeof message.date === 'number' ? message.date * 1000 : Date.now(),
  }
}

/**
 * Updates that are not messages, as events: members joining and leaving (service messages
 * `new_chat_members` and `left_chat_member`), the bot's own membership (`my_chat_member`),
 * `chat_member`, `chat_join_request` and inline button presses (`callback_query`).
 */
export function decodeEvents(update: any): BotEvent[] {
  const message = update.message
  if (message?.new_chat_members) {
    return message.new_chat_members.map((member: any) => ({
      type: 'telegram', name: 'new_chat_members', data: { ...message, member }, channel: channelOf(message.chat), user: userOf(member),
    }))
  }
  if (message?.left_chat_member) {
    return [{ type: 'telegram', name: 'left_chat_member', data: message, channel: channelOf(message.chat), user: userOf(message.left_chat_member) }]
  }
  for (const name of ['my_chat_member', 'chat_member', 'chat_join_request']) {
    const data = update[name]
    if (data) return [{ type: 'telegram', name, data, channel: channelOf(data.chat), user: userOf(data.new_chat_member?.user ?? data.from) }]
  }
  const query = update.callback_query
  if (query) {
    return [{
      type: 'telegram',
      name: 'callback_query',
      data: query,
      ...(query.message?.chat ? { channel: channelOf(query.message.chat) } : {}),
      user: userOf(query.from),
    }]
  }
  return []
}

/** Text and the `text_mention` entities that turn `at` segments into links to people. */
export function buildText(segments: Segment[]) {
  let text = ''
  const entities: any[] = []
  for (const segment of segments) {
    if (segment.type === 'text') text += segment.data.text ?? ''
    else if (segment.type === 'at') {
      const id = String(segment.data.qq ?? segment.data.id ?? '')
      if (!/^\d+$/.test(id)) continue
      const label = `@${segment.data.name || id}`
      entities.push({ type: 'text_mention', offset: text.length, length: label.length, user: { id: Number(id) } })
      text += label
    }
  }
  return { text, entities }
}
