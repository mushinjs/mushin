import type { MessageRecord, Segment } from '@mushin/core'

/** One message as the planner and the replier read it. */
export interface TranscriptLine {
  /** Short id such as `#12`, numbered within this transcript, so a model can point at a message. */
  ref: string
  record: MessageRecord
  /** True for the bot's own messages. */
  self: boolean
  text: string
}

export interface Transcript {
  lines: TranscriptLine[]
  /** The transcript as text, one message per line. */
  text: string
  /** The line a short id points at. */
  find(ref: string): TranscriptLine | undefined
}

const pad = (value: number) => String(value).padStart(2, '0')
const clock = (time: number) => {
  const date = new Date(time)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A segment as words in the transcript; images and the like become placeholders. */
function segmentText(segment: Segment, selfId: string | undefined) {
  switch (segment.type) {
    case 'text': return segment.data.text ?? ''
    case 'at': return String(segment.data.qq) === selfId ? '@你' : `@${segment.data.name ?? segment.data.qq}`
    case 'face': return '[表情]'
    case 'mface': return '[表情包]'
    case 'image': return segment.data.summary ? `[图片：${segment.data.summary}]` : '[图片]'
    case 'record': return '[语音]'
    case 'video': return '[视频]'
    case 'file': return `[文件${segment.data.name ? `：${segment.data.name}` : ''}]`
    case 'forward': case 'node': return '[聊天记录]'
    case 'json': case 'xml': case 'ark': case 'markdown': return '[卡片]'
    case 'reply': return ''
    default: return `[${segment.type}]`
  }
}

const ROLE: Record<string, string> = { owner: '群主', admin: '管理员' }

/**
 * Turns a chat's recent messages, oldest first, into a transcript: who said what and when, with
 * short ids and the message each one replies to.
 */
export function buildTranscript(records: MessageRecord[], options: { selfId?: string; selfName?: string; maxChars?: number } = {}): Transcript {
  const maxChars = options.maxChars ?? 300
  const lines: TranscriptLine[] = []
  const byMessageId = new Map<string, TranscriptLine>()
  for (const [index, record] of records.entries()) {
    const self = record.direction === 'out'
    let text = record.segments.map((segment) => segmentText(segment, options.selfId)).join('').replace(/\s+/g, ' ').trim()
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`
    if (!text) continue
    const line: TranscriptLine = { ref: `#${index + 1}`, record, self, text }
    lines.push(line)
    if (record.messageId) byMessageId.set(record.messageId, line)
  }
  const rendered = lines.map((line) => {
    const { record } = line
    const role = !line.self && record.user.role ? ROLE[record.user.role] : undefined
    const who = line.self ? `你（${options.selfName ?? record.user.name ?? '机器人'}）` : `${record.user.name || record.user.id}${role ? `（${role}）` : ''}`
    const quoted = record.segments.find((segment) => segment.type === 'reply')
    const target = quoted ? byMessageId.get(String(quoted.data.id)) : undefined
    return `[${line.ref} ${clock(record.timestamp)}] ${who}：${line.text}${target ? `（回复 ${target.ref}）` : ''}`
  })
  const refs = new Map(lines.map((line) => [line.ref, line]))
  return { lines, text: rendered.join('\n'), find: (ref) => refs.get(ref.trim().startsWith('#') ? ref.trim() : `#${ref.trim()}`) }
}
