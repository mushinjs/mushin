import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { Segment } from '@mushinjs/core'

/**
 * Where an outgoing image, voice, video or file segment's bytes are. Segments follow OneBot, so
 * `file` (or `url`) holds an http(s) address, a `base64://` or `data:` payload, or a local path.
 */
export type MediaSource =
  | { kind: 'url'; url: string; name?: string }
  | { kind: 'bytes'; bytes: Buffer; name: string; mime: string }

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.amr': 'audio/amr',
  '.silk': 'audio/silk',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
}

const DEFAULT_EXT: Record<string, string> = { image: '.png', record: '.mp3', video: '.mp4', file: '.bin' }

/** A media type from a file name, or a fallback for the segment type. */
export function mimeOf(name: string, type = 'file') {
  return MIME[extname(name).toLowerCase()] ?? (type === 'image' ? 'image/png' : type === 'record' ? 'audio/mpeg' : type === 'video' ? 'video/mp4' : 'application/octet-stream')
}

/** Reads where a media segment's content is; local files and inline payloads are read into memory. */
export async function mediaSource(segment: Segment): Promise<MediaSource> {
  const value = String(segment.data.url || segment.data.file || segment.data.path || '')
  const given = typeof segment.data.name === 'string' && segment.data.name ? segment.data.name : undefined
  if (!value) throw new Error(`the ${segment.type} segment has no file or url`)
  const fallbackName = given ?? `${segment.type}${DEFAULT_EXT[segment.type] ?? '.bin'}`
  if (/^https?:\/\//i.test(value)) return { kind: 'url', url: value, ...(given ? { name: given } : {}) }
  if (value.startsWith('base64://')) {
    return { kind: 'bytes', bytes: Buffer.from(value.slice(9), 'base64'), name: fallbackName, mime: mimeOf(fallbackName, segment.type) }
  }
  const data = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value)
  if (data) {
    const bytes = data[2] ? Buffer.from(data[3], 'base64') : Buffer.from(decodeURIComponent(data[3]))
    return { kind: 'bytes', bytes, name: fallbackName, mime: data[1] || mimeOf(fallbackName, segment.type) }
  }
  const path = value.replace(/^file:\/\/\/?/i, process.platform === 'win32' ? '' : '/')
  const name = given ?? basename(path)
  return { kind: 'bytes', bytes: await readFile(path), name, mime: mimeOf(name, segment.type) }
}

/** The bytes of a media segment, downloading http(s) addresses; for platforms that only take uploads. */
export async function mediaBytes(segment: Segment, timeout = 30_000) {
  const source = await mediaSource(segment)
  if (source.kind === 'bytes') return source
  const response = await fetch(source.url, { signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error(`downloading ${source.url} failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const name = source.name ?? (basename(new URL(source.url).pathname) || `${segment.type}${DEFAULT_EXT[segment.type] ?? '.bin'}`)
  const header = response.headers.get('content-type')?.split(';')[0]
  return { kind: 'bytes' as const, bytes, name, mime: header && header !== 'application/octet-stream' ? header : mimeOf(name, segment.type) }
}

/** The media segment types adapters send as attachments. */
export const MEDIA_SEGMENTS = new Set(['image', 'record', 'video', 'file'])
