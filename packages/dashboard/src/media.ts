import { call } from './api'
import type { Segment } from './types'

/** Where a message was sent, as the platform needs it to find a group file. */
export interface MediaChannel {
  type: string
  id: string
}

/** One message of a forwarded chat history. */
export interface ForwardedMessage {
  user: { id: string; name?: string }
  timestamp: number
  segments: Segment[]
}

export interface ResolvedMedia {
  url: string
  name?: string
  size?: number
}

/** An address the browser can load: http(s), protocol-relative or a data URL. */
export function loadableUrl(value: unknown) {
  if (typeof value !== 'string') return undefined
  if (value.startsWith('//')) return `https:${value}`
  return /^(https?:|data:)/.test(value) ? value : undefined
}

/** A forwarded message as NapCat sends it inside a segment: an OneBot message or a `node` segment. */
export function forwardedMessage(item: any): ForwardedMessage {
  const node = item?.type === 'node' ? item.data ?? {} : item ?? {}
  const sender = node.sender ?? {}
  const content = node.message ?? node.content ?? []
  return {
    user: {
      id: String(node.user_id ?? node.uin ?? sender.user_id ?? ''),
      name: sender.card || sender.nickname || node.nickname || node.name || undefined,
    },
    timestamp: typeof node.time === 'number' ? node.time * 1000 : 0,
    segments: Array.isArray(content)
      ? content.map((segment: any) => ({ type: String(segment?.type), data: segment?.data ?? {} }))
      : [{ type: 'text', data: { text: String(content) } }],
  }
}

// Kept for the page's lifetime, so scrolling back or reopening a history asks the platform once.
const forwards = new Map<string, Promise<ForwardedMessage[]>>()
const images = new Map<string, Promise<ResolvedMedia>>()

/** The messages of a forwarded chat history, from the bot's platform. */
export function loadForward(botId: string, id: string) {
  const key = `${botId}:${id}`
  let task = forwards.get(key)
  if (!task) {
    task = call<{ messages: ForwardedMessage[] }>('bots.forward', { id: botId, forward: id }).then((result) => result.messages)
    task.catch(() => forwards.delete(key))
    forwards.set(key, task)
  }
  return task
}

/**
 * A current address for an image, video or file: the one in the message expires after a few hours.
 * `inline` fetches the bytes through Mushin, for showing an image in place.
 */
export function resolveMedia(botId: string, segment: Segment, channel?: MediaChannel, inline = false) {
  const input = {
    id: botId,
    segment: { type: segment.type, data: segment.data },
    ...(channel && (channel.type === 'group' || channel.type === 'private') ? { channel: { type: channel.type, id: channel.id } } : {}),
    inline,
  }
  if (!inline) return call<ResolvedMedia>('bots.media', input)
  const key = `${botId}:${segment.data.file ?? segment.data.file_id ?? segment.data.url}`
  let task = images.get(key)
  if (!task) {
    task = call<ResolvedMedia>('bots.media', input)
    task.catch(() => images.delete(key))
    images.set(key, task)
  }
  return task
}

/** Saves a file through the browser; another site's file opens in a new tab when it cannot be saved directly. */
export function saveFile(url: string, name?: string) {
  const link = document.createElement('a')
  link.href = url
  link.target = '_blank'
  link.rel = 'noreferrer noopener'
  if (name) link.download = name
  link.click()
}
