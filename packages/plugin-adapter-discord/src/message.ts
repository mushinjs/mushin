import { type Segment, seg, type UserInfo } from '@mushinjs/core'
import type { IncomingMessage } from '@mushinjs/plugin-bots'

/** Segment types this adapter sends. */
export const DISCORD_SEGMENTS = ['text', 'at', 'image', 'record', 'video', 'file', 'reply']

/** Discord's message length limit. */
export const CONTENT_LIMIT = 2000

/** The name Discord shows: the server nickname, the display name, then the username. */
export function displayName(author: any, member?: any): string | undefined {
  return member?.nick || author?.global_name || author?.username || undefined
}

/**
 * Message text as segments: user mentions (`<@id>`, `<@!id>`) become `at` segments; custom
 * emoji (`<:name:id>`) become `:name:`; role and channel mentions stay as written.
 */
export function parseContent(content: string, mentions: any[] = []): Segment[] {
  const segments: Segment[] = []
  const pushText = (text: string) => {
    if (!text) return
    const last = segments.at(-1)
    if (last?.type === 'text') last.data.text += text
    else segments.push(seg.text(text))
  }
  let cursor = 0
  for (const match of content.matchAll(/<@!?(\d+)>|<a?:(\w+):\d+>/g)) {
    pushText(content.slice(cursor, match.index))
    cursor = match.index! + match[0].length
    if (match[1]) {
      const mentioned = mentions.find((item) => item.id === match[1])
      segments.push(seg.at(match[1], displayName(mentioned, mentioned?.member)))
    } else pushText(`:${match[2]}:`)
  }
  pushText(content.slice(cursor))
  return segments
}

export function parseAttachments(message: any): Segment[] {
  const segments: Segment[] = (message.attachments ?? []).map((item: any): Segment => {
    const type = String(item.content_type ?? '')
    const kind = type.startsWith('image') ? 'image' : type.startsWith('video') ? 'video' : type.startsWith('audio') ? 'record' : 'file'
    return { type: kind, data: { file: item.url, url: item.url, ...(item.filename ? { name: item.filename } : {}), ...(item.size ? { size: item.size } : {}) } }
  })
  for (const sticker of message.sticker_items ?? []) {
    // Format 3 is a Lottie animation, which has no picture address.
    if (sticker.format_type === 3) continue
    const url = `https://media.discordapp.net/stickers/${sticker.id}.${sticker.format_type === 4 ? 'gif' : 'png'}`
    segments.push({ type: 'image', data: { file: url, url, sticker: true, summary: sticker.name } })
  }
  return segments
}

/** Guild facts kept from `GUILD_CREATE`, for names, contacts and roles. */
export interface GuildInfo {
  id: string
  name?: string
  ownerId?: string
  /** Role ids whose permissions include Administrator. */
  adminRoles: Set<string>
}

const ADMINISTRATOR = 1n << 3n

export function guildInfo(guild: any): GuildInfo {
  const adminRoles = new Set<string>()
  for (const role of guild.roles ?? []) {
    try {
      if (BigInt(role.permissions ?? 0) & ADMINISTRATOR) adminRoles.add(String(role.id))
    } catch {}
  }
  return { id: String(guild.id), name: guild.name, ownerId: guild.owner_id ? String(guild.owner_id) : undefined, adminRoles }
}

/** A member's role in Mushin's terms: the guild owner, an Administrator, or a member. */
export function memberRole(guild: GuildInfo | undefined, userId: string, roles: string[] | undefined): UserInfo['role'] {
  if (!guild) return
  if (guild.ownerId === userId) return 'owner'
  if (roles?.some((role) => guild.adminRoles.has(role))) return 'admin'
  return 'member'
}

/**
 * A `MESSAGE_CREATE` as an incoming message. A guild message happens in its channel; a DM in a
 * private chat with the author, whose DM channel the adapter remembers for answers.
 */
export function decodeMessage(message: any, context: { guild?: GuildInfo; channelName?: string } = {}): IncomingMessage | undefined {
  if (!message?.author || !message.channel_id) return
  const author = message.author
  const name = displayName(author, message.member)
  const user: UserInfo = { id: String(author.id), ...(name ? { name } : {}) }
  if (message.guild_id) {
    const role = memberRole(context.guild, user.id, message.member?.roles)
    if (role) user.role = role
  }
  const segments = [...parseContent(String(message.content ?? ''), message.mentions), ...parseAttachments(message)]
  if (!segments.length) return
  // Type 19 is a reply; type 0 can carry a reference too (a forward has none of these).
  const quoted = message.message_reference?.message_id
  if (quoted && (message.type === 19 || message.referenced_message)) segments.unshift(seg.reply(String(quoted)))
  const time = Date.parse(message.timestamp)
  return {
    messageId: String(message.id),
    channel: message.guild_id
      ? { type: 'group', id: String(message.channel_id), ...(context.channelName ? { name: context.channelName } : {}) }
      : { type: 'private', id: user.id, ...(name ? { name } : {}) },
    user,
    segments,
    timestamp: Number.isFinite(time) ? time : Date.now(),
  }
}

/** Text with mentions in Discord's syntax, cut into pieces Discord accepts. */
export function buildContent(segments: Segment[]) {
  let text = ''
  let everyone = false
  for (const segment of segments) {
    if (segment.type === 'text') text += segment.data.text ?? ''
    else if (segment.type === 'at') {
      const id = String(segment.data.qq ?? segment.data.id ?? '')
      if (id === 'all') {
        text += '@everyone'
        everyone = true
      } else if (/^\d+$/.test(id)) text += `<@${id}>`
    }
  }
  const chunks: string[] = []
  for (let rest = text; rest.length; ) {
    if (rest.length <= CONTENT_LIMIT) {
      chunks.push(rest)
      break
    }
    // Break at the last line end or space before the limit, when there is one.
    const window = rest.slice(0, CONTENT_LIMIT)
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '))
    const at = cut > CONTENT_LIMIT / 2 ? cut + 1 : CONTENT_LIMIT
    chunks.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  return { chunks: chunks.filter((chunk) => chunk.trim()), everyone }
}
