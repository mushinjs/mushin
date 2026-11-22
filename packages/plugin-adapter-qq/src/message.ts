import { type ChannelInfo, type Segment, seg, type UserInfo } from '@mushinjs/core'
import type { BotEvent, IncomingMessage } from '@mushinjs/plugin-bots'

/** Segment types this adapter sends. */
export const QQ_SEGMENTS = ['text', 'at', 'face', 'image', 'record', 'video', 'file', 'reply', 'markdown']

/**
 * Where a QQ message happens. Group chats and C2C (private) chats use openids, which are hex
 * strings; guild channels and guild DMs use numeric ids. Mushin keeps the plain id, and the
 * kind is told apart by its shape (see `chatKind`).
 */
export type ChatKind = 'group' | 'c2c' | 'channel' | 'dms'

const numeric = (id: string) => /^\d+$/.test(id)

/** Which API a Mushin channel goes to; a numeric private id is a guild member, reached through DMs. */
export function chatKind(channel: ChannelInfo): ChatKind {
  if (channel.type === 'group') return numeric(channel.id) ? 'channel' : 'group'
  return numeric(channel.id) ? 'dms' : 'c2c'
}

function unescape(text: string) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&')
}

/**
 * Text of a QQ message as segments: `<@!id>` / `<@id>` mentions, `<emoji:id>` and
 * `<faceType=…,faceId="id">` faces; the rest is text with QQ's HTML escapes undone.
 */
export function parseContent(content: string, mentions: { id?: string; username?: string; member_openid?: string }[] = []): Segment[] {
  const segments: Segment[] = []
  const pattern = /<@!?(\w+)>|<emoji:(\d+)>|<faceType=\d+,faceId="(\d+)"[^>]*>/g
  let last = 0
  const pushText = (text: string) => {
    if (!text) return
    const previous = segments.at(-1)
    if (previous?.type === 'text') previous.data.text += unescape(text)
    else segments.push(seg.text(unescape(text)))
  }
  for (const match of content.matchAll(pattern)) {
    pushText(content.slice(last, match.index))
    last = match.index! + match[0].length
    if (match[1]) {
      const name = mentions.find((item) => item.id === match[1] || item.member_openid === match[1])?.username
      segments.push(seg.at(match[1], name))
    } else {
      segments.push(seg.face(match[2] ?? match[3]))
    }
  }
  pushText(content.slice(last))
  return segments
}

/** Attachments (images, voice, video, files) as segments; QQ sometimes leaves out the scheme. */
export function parseAttachments(attachments: any[] | undefined): Segment[] {
  if (!Array.isArray(attachments)) return []
  return attachments.flatMap((item): Segment[] => {
    if (!item?.url) return []
    const url = /^https?:\/\//.test(item.url) ? String(item.url) : `https://${item.url}`
    const type = String(item.content_type ?? '')
    const name = item.filename ? { name: String(item.filename) } : {}
    const size = item.size ? { size: Number(item.size) } : {}
    if (type.startsWith('image')) return [{ type: 'image', data: { file: url, url, ...name, ...size } }]
    if (type.startsWith('video')) return [{ type: 'video', data: { file: url, url, ...name, ...size } }]
    if (type === 'voice' || type.startsWith('audio')) return [{ type: 'record', data: { file: url, url, ...name, ...size } }]
    return [{ type: 'file', data: { file: url, url, ...name, ...size } }]
  })
}

/** Guild role ids QQ reserves: 4 is the guild owner, 2 a super admin, 5 a channel admin. */
function guildRole(roles: unknown): UserInfo['role'] {
  if (!Array.isArray(roles)) return
  if (roles.includes('4')) return 'owner'
  if (roles.includes('2') || roles.includes('5')) return 'admin'
  return 'member'
}

const timestampOf = (value: unknown) => {
  const time = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value * 1000 : NaN
  return Number.isFinite(time) ? time : Date.now()
}

/** Event types that carry a message. */
export const MESSAGE_EVENTS = new Set(['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE', 'AT_MESSAGE_CREATE', 'MESSAGE_CREATE', 'DIRECT_MESSAGE_CREATE'])

export interface DecodedMessage extends IncomingMessage {
  /** For a guild DM: the DM session's guild, which sending back needs. */
  dmsGuild?: string
}

/**
 * Turns a dispatched message event into an incoming message. A group message that @-mentions the
 * bot (the only kind public group bots receive) starts with a mention of the bot, so plugins that
 * answer only when mentioned see one; QQ itself strips it from the text.
 */
export function decodeMessage(type: string, d: any, selfId?: string): DecodedMessage | undefined {
  if (!MESSAGE_EVENTS.has(type) || !d) return
  const author = d.author ?? {}
  let channel: ChannelInfo
  let user: UserInfo
  let segments: Segment[]
  let dmsGuild: string | undefined
  if (type === 'GROUP_AT_MESSAGE_CREATE' || type === 'GROUP_MESSAGE_CREATE') {
    channel = { type: 'group', id: String(d.group_openid ?? d.group_id) }
    user = { id: String(author.member_openid ?? author.id ?? '') }
    segments = parseContent(String(d.content ?? '').replace(/^\s+/, ''))
    if (type === 'GROUP_AT_MESSAGE_CREATE' && selfId) segments.unshift(seg.at(selfId))
  } else if (type === 'C2C_MESSAGE_CREATE') {
    channel = { type: 'private', id: String(author.user_openid ?? author.id ?? '') }
    user = { id: channel.id }
    segments = parseContent(String(d.content ?? '').replace(/^\s+/, ''))
  } else {
    const name = d.member?.nick || author.username || undefined
    user = { id: String(author.id ?? ''), ...(name ? { name } : {}) }
    if (type === 'DIRECT_MESSAGE_CREATE') {
      channel = { type: 'private', id: user.id, ...(name ? { name } : {}) }
      dmsGuild = String(d.guild_id)
    } else {
      channel = { type: 'group', id: String(d.channel_id) }
      const role = guildRole(d.member?.roles)
      if (role) user.role = role
    }
    segments = parseContent(String(d.content ?? ''), d.mentions)
  }
  // A mention of the bot followed by a space: keep the text after it clean for commands.
  const first = segments.findIndex((item) => item.type === 'text')
  if (first > 0 && segments.slice(0, first).every((item) => item.type === 'at')) {
    segments[first] = seg.text(segments[first].data.text.replace(/^\s+/, ''))
    if (!segments[first].data.text) segments.splice(first, 1)
  }
  segments.push(...parseAttachments(d.attachments))
  const quoted = d.message_reference?.message_id
  if (quoted) segments.unshift(seg.reply(String(quoted)))
  return {
    messageId: d.id ? String(d.id) : undefined,
    channel,
    user,
    segments,
    timestamp: timestampOf(d.timestamp),
    ...(dmsGuild ? { dmsGuild } : {}),
  }
}

/**
 * A non-message event (a group adding the bot, a friend adding it, a guild member joining…) as a
 * `BotEvent` named after QQ's event type in lower case, e.g. `group_add_robot` or `friend_add`.
 */
export function decodeEvent(type: string, d: any, id?: string): BotEvent {
  const data = d ?? {}
  const event: BotEvent = { type: 'qq', name: type.toLowerCase(), data: { ...data, event_type: type, ...(id ? { event_id: id } : {}) } }
  const userId = data.op_member_openid ?? data.openid ?? data.user?.id ?? data.op_user_id ?? data.user_openid
  const groupId = data.group_openid
  if (groupId) event.channel = { type: 'group', id: String(groupId) }
  else if (data.channel_id && data.guild_id) event.channel = { type: 'group', id: String(data.channel_id) }
  else if (userId) event.channel = { type: 'private', id: String(userId) }
  if (userId) event.user = { id: String(userId), ...(data.user?.username ? { name: String(data.user.username) } : {}) }
  return event
}

/** An outgoing message split the way QQ sends it: text with mentions, media, a markdown body. */
export interface OutgoingParts {
  text: string
  media: Segment[]
  markdown?: string
  reply?: string
}

/** Splits segments into what one QQ message can hold; mentions only work in guilds. */
export function splitOutgoing(segments: Segment[], kind: ChatKind): OutgoingParts {
  let text = ''
  const media: Segment[] = []
  let markdown: string | undefined
  let reply: string | undefined
  for (const segment of segments) {
    if (segment.type === 'text') text += segment.data.text ?? ''
    else if (segment.type === 'at') {
      const id = String(segment.data.qq ?? segment.data.id ?? '')
      if (id === 'all') text += kind === 'channel' ? '@everyone' : '@全体成员'
      else if (kind === 'channel' || kind === 'dms') text += `<@${id}>`
      else if (segment.data.name) text += `@${segment.data.name}`
    } else if (segment.type === 'face') {
      if (kind === 'channel' || kind === 'dms') text += `<emoji:${segment.data.id}>`
    } else if (segment.type === 'reply') reply ??= String(segment.data.id)
    else if (segment.type === 'markdown') markdown = String(segment.data.content ?? segment.data.text ?? '')
    else if (segment.type === 'image' || segment.type === 'record' || segment.type === 'video' || segment.type === 'file') media.push(segment)
  }
  return { text, media, markdown, reply }
}

/** QQ's rich media types for group and C2C uploads. */
export const FILE_TYPES: Record<string, number> = { image: 1, video: 2, record: 3, file: 4 }
