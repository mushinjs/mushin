/**
 * Message segments follow OneBot v11 segments, because OneBot is the first adapter.
 * Other adapters convert to and from this shape.
 */
export interface Segment {
  type: string
  data: Record<string, any>
}

export const seg = {
  text: (text: string): Segment => ({ type: 'text', data: { text } }),
  at: (id: string, name?: string): Segment => ({ type: 'at', data: { qq: id, ...(name ? { name } : {}) } }),
  image: (file: string): Segment => ({ type: 'image', data: { file } }),
  reply: (id: string): Segment => ({ type: 'reply', data: { id } }),
  face: (id: string): Segment => ({ type: 'face', data: { id } }),
}

export type Content = string | Segment | Segment[]

export function toSegments(content: Content): Segment[] {
  if (typeof content === 'string') return [seg.text(content)]
  if (Array.isArray(content)) return content
  return [content]
}

/** Plain text of a message: text segments joined, other segments as short placeholders. */
export function segmentsToText(segments: Segment[], placeholders = true) {
  return segments.map((s) => {
    if (s.type === 'text') return s.data.text ?? ''
    if (!placeholders) return ''
    if (s.type === 'at') return `@${s.data.name ?? s.data.qq}`
    if (s.type === 'face') return '[face]'
    if (s.type === 'reply') return ''
    return `[${s.type}]`
  }).join('')
}

export type MessageType = 'text' | 'image' | 'voice' | 'video' | 'file' | 'card' | 'forward' | 'mixed'

const segmentKinds: Record<string, MessageType> = {
  text: 'text', at: 'text', face: 'text', reply: 'text',
  image: 'image', mface: 'image',
  record: 'voice',
  video: 'video',
  file: 'file',
  json: 'card', xml: 'card', markdown: 'card', ark: 'card',
  forward: 'forward', node: 'forward',
}

/** One kind of content gives that type; text plus anything else, or two other kinds, give `mixed`. */
export function messageType(segments: Segment[]): MessageType {
  const kinds = new Set(segments.map((s) => segmentKinds[s.type] ?? 'mixed'))
  if (kinds.size === 0) return 'text'
  if (kinds.size === 1) return [...kinds][0]
  return 'mixed'
}

/** A knowledge base passage a reply was written from. */
export interface KnowledgeSource {
  base: string
  doc: string
  chunk: string
  title: string
}

export type Provenance =
  | { kind: 'user' }
  | { kind: 'plugin'; plugin: string }
  | { kind: 'llm'; plugin?: string; provider: string; model: string; latencyMs: number; tokens?: number; persona?: string }
  | { kind: 'flow'; flow: string; node: string; provider?: string; model?: string; persona?: string; knowledge?: KnowledgeSource[] }
  | { kind: 'agent'; session: string }
  | { kind: 'manual' }

export interface ChannelInfo {
  type: 'group' | 'private'
  id: string
  name?: string
  /** For a private chat started from a group (a temporary chat): that group's id. */
  fromGroup?: string
}

export interface UserInfo {
  id: string
  name?: string
  /** The sender's role in a group chat, when the platform reports it. */
  role?: 'owner' | 'admin' | 'member'
}

export interface MessageRecord {
  id: string
  botId: string
  /** Platform message id, when the platform returned one. */
  messageId?: string
  direction: 'in' | 'out'
  channel: ChannelInfo
  user: UserInfo
  segments: Segment[]
  timestamp: number
  replyTo?: string
  type: MessageType
  /** Adapters that can render every segment of this message. */
  platforms: string[]
  source: Provenance
}
