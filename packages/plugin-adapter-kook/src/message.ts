import { type ChannelInfo, type Segment, seg, type UserInfo } from '@mushinjs/core'
import type { BotEvent, IncomingMessage } from '@mushinjs/plugin-bots'

/** Segment types this adapter sends. */
export const KOOK_SEGMENTS = ['text', 'at', 'image', 'record', 'video', 'file', 'reply', 'markdown']

/** KOOK's message types. */
export const MessageType = { text: 1, image: 2, video: 3, file: 4, audio: 8, kmarkdown: 9, card: 10, system: 255 } as const

const unescape = (text: string) => text.replace(/\\(.)/g, '$1')

/**
 * KMarkdown as segments: `(met)id(met)` mentions (`all` and `here` too) become `at` segments,
 * `(emj)name(emj)[id]` emoji become `:name:`, role and channel mentions keep their text, and
 * backslash escapes are undone.
 */
export function parseKMarkdown(content: string, options: { escaped?: boolean; names?: Record<string, string> } = {}): Segment[] {
  const segments: Segment[] = []
  const pushText = (text: string) => {
    if (!text) return
    const value = options.escaped ? unescape(text) : text
    const last = segments.at(-1)
    if (last?.type === 'text') last.data.text += value
    else segments.push(seg.text(value))
  }
  let cursor = 0
  for (const match of content.matchAll(/\(met\)(\w+)\(met\)|\(emj\)(.+?)\(emj\)\[[^\]]*\]|\(rol\)(\d+)\(rol\)|\(chn\)(\d+)\(chn\)/g)) {
    pushText(content.slice(cursor, match.index))
    cursor = match.index! + match[0].length
    if (match[1]) {
      const id = match[1] === 'here' ? 'all' : match[1]
      segments.push(seg.at(id, options.names?.[match[1]]))
    } else if (match[2]) pushText(`:${match[2]}:`)
    else if (match[3]) pushText(`@role:${match[3]}`)
    else pushText(`#${match[4]}`)
  }
  pushText(content.slice(cursor))
  return segments
}

/** Characters KMarkdown gives a meaning to, escaped so text shows as written. */
export function escapeKMarkdown(text: string) {
  return text.replace(/([\\*~[\]()>`_|-])/g, '\\$1')
}

function mediaSegment(type: string, url: string, attachment?: any): Segment {
  return { type, data: { file: url, url, ...(attachment?.name ? { name: attachment.name } : {}), ...(attachment?.size ? { size: attachment.size } : {}) } }
}

/** A text, picture, video, file, voice or KMarkdown message as an incoming message. */
export function decodeMessage(d: any): IncomingMessage | undefined {
  if (!d || d.type === MessageType.system) return
  const extra = d.extra ?? {}
  const author = extra.author ?? {}
  const authorName = author.nickname || author.username || undefined
  const user: UserInfo = { id: String(d.author_id), ...(authorName ? { name: authorName } : {}) }
  let channel: ChannelInfo
  if (d.channel_type === 'GROUP') channel = { type: 'group', id: String(d.target_id), ...(extra.channel_name ? { name: String(extra.channel_name) } : {}) }
  else if (d.channel_type === 'PERSON') channel = { type: 'private', id: user.id, ...(author.username ? { name: String(author.username) } : {}) }
  else return
  const content = String(d.content ?? '')
  const attachment = extra.attachments
  let segments: Segment[]
  switch (d.type) {
    case MessageType.text:
    case MessageType.kmarkdown: {
      const names: Record<string, string> = {}
      for (const part of extra.kmarkdown?.mention_part ?? []) if (part?.id) names[String(part.id)] = part.full_name || part.username
      segments = parseKMarkdown(content, { escaped: d.type === MessageType.kmarkdown, names })
      break
    }
    case MessageType.image:
      segments = [mediaSegment('image', attachment?.url || content, attachment)]
      break
    case MessageType.video:
      segments = [mediaSegment('video', attachment?.url || content, attachment)]
      break
    case MessageType.file:
      segments = [mediaSegment('file', attachment?.url || content, attachment)]
      break
    case MessageType.audio:
      segments = [mediaSegment('record', attachment?.url || content, attachment)]
      break
    case MessageType.card:
      segments = [{ type: 'card', data: { content } }]
      break
    default:
      return
  }
  if (extra.quote?.id) segments.unshift(seg.reply(String(extra.quote.id)))
  return {
    messageId: d.msg_id ? String(d.msg_id) : undefined,
    channel,
    user,
    segments,
    timestamp: typeof d.msg_timestamp === 'number' ? d.msg_timestamp : Date.now(),
  }
}

/**
 * A system event (type 255) as a `BotEvent` named after its `extra.type`, e.g. `joined_guild`,
 * `added_reaction` or `message_btn_click`.
 */
export function decodeEvent(d: any): BotEvent | undefined {
  const name = d?.extra?.type
  if (d?.type !== MessageType.system || typeof name !== 'string') return
  const body = d.extra.body ?? {}
  const userId = body.user_id ?? body.author_id
  const event: BotEvent = { type: 'kook', name, data: { ...body, guild_id: d.channel_type === 'GROUP' ? d.target_id : body.guild_id, event_type: name } }
  const channelId = body.channel_id ?? body.target_id
  if (channelId && d.channel_type === 'GROUP') event.channel = { type: 'group', id: String(channelId) }
  else if (userId) event.channel = { type: 'private', id: String(userId) }
  if (userId) event.user = { id: String(userId), ...(body.user_info?.username ? { name: String(body.user_info.username) } : {}) }
  return event
}

/** Text of an outgoing message: plain text, or KMarkdown when it mentions someone. */
export function buildContent(segments: Segment[]) {
  const mentions = segments.some((item) => item.type === 'at')
  let content = ''
  for (const segment of segments) {
    if (segment.type === 'text') content += mentions ? escapeKMarkdown(segment.data.text ?? '') : segment.data.text ?? ''
    else if (segment.type === 'at') content += `(met)${segment.data.qq ?? segment.data.id}(met)`
  }
  return { content, type: mentions ? MessageType.kmarkdown : MessageType.text }
}
