import type { WebSocket } from 'ws'
import type { ChannelInfo, Context, Segment } from '@mushin/core'
import type {} from '@mushin/plugin-bots'

export interface OneBotResponse {
  status: 'ok' | 'async' | 'failed'
  retcode: number
  data: any
  message?: string
  wording?: string
  echo?: string
}

export class OneBotError extends Error {
  name = 'OneBotError'
  constructor(public action: string, public response: OneBotResponse) {
    super(`OneBot ${action} failed (retcode ${response.retcode}): ${response.wording || response.message || response.status}`)
  }
}

const CALL_TIMEOUT = 30_000
const DEFAULT_HEARTBEAT = 30_000

/** Segment types this adapter sends; drives the "supported platforms" field of message records. */
export const ONEBOT_SEGMENTS = ['text', 'at', 'face', 'image', 'record', 'video', 'reply', 'file', 'json', 'xml', 'forward', 'node', 'poke', 'dice', 'rps', 'music', 'mface', 'markdown']

function toId(value: string) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : value
}

/** Strips fields Mushin adds for display, so NapCat receives plain OneBot segments. */
function toOneBotSegment(segment: Segment) {
  if (segment.type === 'at') return { type: 'at', data: { qq: segment.data.qq } }
  return segment
}

/**
 * One OneBot v11 universal connection: API calls matched by `echo`, events turned into sessions.
 * Forward and reverse modes share this; they differ only in who opens the socket.
 */
export class OneBotConnection {
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private counter = 0
  private heartbeatInterval = DEFAULT_HEARTBEAT
  private watchdog?: NodeJS.Timeout
  private warnedStringFormat = false
  private disposed = false
  private loginTask?: Promise<void>
  private logger

  constructor(private ctx: Context, private socket: WebSocket, private onDead: () => void) {
    this.logger = ctx.logger('onebot')
    socket.on('message', (data) => this.handle(data.toString()))
    socket.on('close', () => this.dispose(new Error('connection closed')))
    this.touch()
  }

  /** Resets the heartbeat watchdog; a silent connection is treated as dead after two missed beats. */
  private touch() {
    clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => {
      this.logger.warn('no heartbeat from %s for %ds, reconnecting', this.ctx.bot.record.name, (this.heartbeatInterval * 2) / 1000)
      this.socket.terminate()
      this.onDead()
    }, this.heartbeatInterval * 2)
  }

  dispose(reason = new Error('connection disposed')) {
    this.disposed = true
    clearTimeout(this.watchdog)
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(reason)
    }
    this.pending.clear()
  }

  call(action: string, params: Record<string, any> = {}): Promise<any> {
    const echo = `${Date.now().toString(36)}-${++this.counter}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`OneBot ${action} timed out after ${CALL_TIMEOUT / 1000}s`))
      }, CALL_TIMEOUT)
      this.pending.set(echo, {
        resolve: (response: OneBotResponse) => {
          if (response.status === 'failed' || (response.retcode !== 0 && response.retcode !== 1)) {
            reject(new OneBotError(action, response))
          } else {
            resolve(response.data)
          }
        },
        reject,
        timer,
      })
      this.socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(error)
      })
    })
  }

  async send(channel: ChannelInfo, segments: Segment[]) {
    const message = segments.map(toOneBotSegment)
    const data = channel.type === 'group'
      ? await this.call('send_group_msg', { group_id: toId(channel.id), message })
      : await this.call('send_private_msg', { user_id: toId(channel.id), message })
    return { messageId: data?.message_id !== undefined ? String(data.message_id) : undefined }
  }

  /**
   * Reads the account behind the connection and marks the bot online. Both the socket opening and
   * NapCat's lifecycle event ask for this, so it runs once per connection (again only after a failure).
   */
  login() {
    this.loginTask ??= this.fetchLogin().catch((error) => {
      this.loginTask = undefined
      throw error
    })
    return this.loginTask
  }

  private async fetchLogin() {
    const info = await this.call('get_login_info')
    this.ctx.bot.setSelf(String(info.user_id), info.nickname)
    this.logger.info('logged in as %s (%s)', info.nickname ?? 'unknown', info.user_id)
    this.ctx.bot.setStatus('online')
  }

  private handle(text: string) {
    if (this.disposed) return
    this.touch()
    let payload: any
    try {
      payload = JSON.parse(text)
    } catch {
      this.logger.warn('received non-JSON frame: %s', text.slice(0, 200))
      return
    }
    if (payload.echo !== undefined && this.pending.has(String(payload.echo))) {
      const entry = this.pending.get(String(payload.echo))!
      this.pending.delete(String(payload.echo))
      clearTimeout(entry.timer)
      entry.resolve(payload)
      return
    }
    switch (payload.post_type) {
      case 'meta_event':
        return this.handleMeta(payload)
      case 'message':
        return this.handleMessage(payload)
      case 'notice':
      case 'request':
        return this.ctx.bot.dispatchEvent({ type: payload.post_type, data: payload })
      // message_sent (NapCat's reportSelfMessage) echoes our own sends; they are recorded on send.
    }
  }

  private handleMeta(payload: any) {
    if (payload.meta_event_type === 'heartbeat' && typeof payload.interval === 'number' && payload.interval > 0) {
      this.heartbeatInterval = payload.interval
      this.touch()
    }
    if (payload.meta_event_type === 'lifecycle' && payload.sub_type === 'connect' && this.ctx.bot.status !== 'online') {
      this.login().catch((error) => this.logger.warn('get_login_info failed: %s', error))
    }
  }

  private handleMessage(payload: any) {
    let segments: Segment[]
    if (Array.isArray(payload.message)) {
      segments = payload.message.map((s: any) => ({ type: String(s.type), data: s.data ?? {} }))
    } else {
      if (!this.warnedStringFormat) {
        this.warnedStringFormat = true
        this.logger.warn('NapCat sends messages in string format; set messagePostFormat to "array" for rich segments')
      }
      segments = [{ type: 'text', data: { text: String(payload.raw_message ?? payload.message ?? '') } }]
    }
    const sender = payload.sender ?? {}
    const userId = String(payload.user_id ?? sender.user_id ?? '')
    const channel: ChannelInfo = payload.message_type === 'group'
      ? { type: 'group', id: String(payload.group_id), ...(payload.group_name ? { name: String(payload.group_name) } : {}) }
      : { type: 'private', id: userId, ...(sender.nickname ? { name: String(sender.nickname) } : {}) }
    this.ctx.bot.receive({
      messageId: payload.message_id !== undefined ? String(payload.message_id) : undefined,
      channel,
      user: { id: userId, name: sender.card || sender.nickname || undefined },
      segments,
      timestamp: typeof payload.time === 'number' ? payload.time * 1000 : Date.now(),
    }).catch((error) => this.logger.warn('failed to handle message: %s', error))
  }
}
