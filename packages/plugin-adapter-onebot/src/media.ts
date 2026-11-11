import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { ChannelInfo, Context, Segment } from '@mushinjs/core'
import type { ForwardedMessage, MediaResolver, ResolvedMedia } from '@mushinjs/plugin-bots'
import { toId } from './protocol'

/** The most bytes sent to the dashboard as a data URL. */
const INLINE_LIMIT = 20 * 1024 * 1024
const FETCH_TIMEOUT = 20_000

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
}

const isHttp = (value: unknown) => typeof value === 'string' && /^https?:\/\//.test(value)

/** The image type from the first bytes; QQ's servers often answer `application/octet-stream`. */
function sniff(bytes: Buffer) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
}

function dataUrl(bytes: Buffer, type?: string | null, name?: string) {
  const mime = sniff(bytes) ?? (type && !type.startsWith('application/octet-stream') ? type.split(';')[0] : undefined)
    ?? (name ? TYPES[extname(name).toLowerCase()] : undefined) ?? 'application/octet-stream'
  return `data:${mime};base64,${bytes.toString('base64')}`
}

async function download(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  if (Number(response.headers.get('content-length')) > INLINE_LIMIT) throw new Error('too large to show')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > INLINE_LIMIT) throw new Error('too large to show')
  return { bytes, type: response.headers.get('content-type') }
}

/** A file on this machine, when NapCat runs here and kept a copy. */
async function readLocal(path: unknown) {
  if (typeof path !== 'string' || !path || isHttp(path)) return
  const file = path.replace(/^file:\/\/\/?/, process.platform === 'win32' ? '' : '/')
  try {
    if ((await stat(file)).size > INLINE_LIMIT) return
    return await readFile(file)
  } catch {
    return undefined
  }
}

/** One message of a forwarded history: an OneBot message from `get_forward_msg`, or a `node` segment. */
export function forwardedMessage(item: any): ForwardedMessage {
  const node = item?.type === 'node' ? item.data ?? {} : item ?? {}
  const sender = node.sender ?? {}
  const content = node.message ?? node.content ?? []
  const segments: Segment[] = Array.isArray(content)
    ? content.map((segment: any) => ({ type: String(segment?.type), data: segment?.data ?? {} }))
    : [{ type: 'text', data: { text: String(content) } }]
  return {
    user: {
      id: String(node.user_id ?? node.uin ?? sender.user_id ?? ''),
      name: sender.card || sender.nickname || node.nickname || node.name || undefined,
    },
    timestamp: typeof node.time === 'number' ? node.time * 1000 : 0,
    segments,
  }
}

/**
 * Media through NapCat. The addresses in QQ messages carry a key that expires after a few hours,
 * so NapCat is asked again (`get_image`, `get_file`, ...) for a current one.
 */
export function onebotMedia(ctx: Context): MediaResolver {
  const logger = ctx.logger('onebot')

  const ask = async (action: string, params: Record<string, any>) => {
    try {
      return await ctx.bot.call(action, params)
    } catch (error) {
      logger.debug('%s failed: %s', action, error)
    }
  }

  /** What NapCat knows about a file now: a fresh address, its path on NapCat's machine, maybe its bytes. */
  async function lookup(segment: Segment, channel?: ChannelInfo): Promise<Record<string, any> | undefined> {
    const data = segment.data
    const ids = { ...(data.file ? { file: data.file } : {}), ...(data.file_id ? { file_id: data.file_id } : {}) }
    if (!Object.keys(ids).length) return
    switch (segment.type) {
      case 'image':
        return ask('get_image', ids)
      case 'record':
        return ask('get_record', { ...ids, out_format: 'mp3' })
      case 'video':
        return ask('get_file', ids)
      case 'file':
        if (data.file_id && channel?.type === 'group') {
          const found = await ask('get_group_file_url', { group_id: toId(channel.id), file_id: data.file_id, busid: data.busid ?? 102 })
          if (found?.url) return found
        }
        if (data.file_id) {
          const found = await ask('get_private_file_url', { file_id: data.file_id })
          if (found?.url) return found
        }
        return ask('get_file', ids)
    }
  }

  return {
    async media(segment, { channel, inline }): Promise<ResolvedMedia | undefined> {
      const info = (await lookup(segment, channel)) ?? {}
      const name: string | undefined = segment.data.name ?? info.file_name ?? (typeof segment.data.file === 'string' ? segment.data.file : undefined)
      const size = Number(info.file_size ?? segment.data.file_size) || undefined
      const addresses: string[] = [...new Set([info.url, segment.data.url].filter(isHttp))]

      if (!inline && addresses[0]) return { url: addresses[0], name, size }
      for (const url of inline ? addresses : []) {
        try {
          const { bytes, type } = await download(url)
          return { url: dataUrl(bytes, type, name), name, size: bytes.length }
        } catch (error) {
          logger.debug('cannot fetch %s: %s', url.slice(0, 80), error)
        }
      }
      if (typeof info.base64 === 'string' && info.base64) {
        const bytes = Buffer.from(info.base64, 'base64')
        return { url: dataUrl(bytes, undefined, name), name, size: bytes.length }
      }
      for (const path of [info.file, segment.data.path]) {
        const bytes = await readLocal(path)
        if (bytes) return { url: dataUrl(bytes, undefined, name), name, size: bytes.length }
      }
    },

    async forward(id) {
      const data = await ctx.bot.call('get_forward_msg', { message_id: id, id })
      const list = Array.isArray(data) ? data : data?.messages ?? data?.message ?? []
      return Array.isArray(list) ? list.map(forwardedMessage) : []
    },
  }
}
