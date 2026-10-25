import type { WebSocket } from 'ws'
import { type ChannelInfo, type Context, type Segment, segmentsToText, type UserInfo } from '@mushin/core'
import type {} from '@mushin/plugin-bots'
import { normalizeEvent } from './events'

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

export function toId(value: string) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : value
}

/** Strips fields Mushin adds for display, so NapCat receives plain OneBot segments. */
function toOneBotSegment(segment: Segment) {
  if (segment.type === 'at') return { type: 'at', data: { qq: segment.data.qq } }
  return segment
}

/**
 * How a connection reaches NapCat. Over WebSocket, `send` writes a frame and the answer comes back
 * through `receive` matched by `echo`; over HTTP, `request` answers directly.
 */
export interface OneBotLink {
  send?(frame: string, done: (error?: Error) => void): void
  request?(action: string, params: Record<string, any>): Promise<OneBotResponse>
  /** Drops the link, e.g. after missed heartbeats. */
  close(): void
}

/**
 * One OneBot v11 connection: API calls, and events turned into sessions. Forward and reverse
 * WebSocket modes and HTTP mode share this; they differ in how frames travel.
 */
export class OneBotConnection {
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private counter = 0
  private heartbeatInterval = DEFAULT_HEARTBEAT
  private watchdog?: NodeJS.Timeout
  private warnedStringFormat = false
  private disposed = false
  private loginTask?: Promise<void>
  /** Set while NapCat reports the QQ account offline, so the bot shows an error instead of "online". */
  private accountOffline?: string
  private logger

  /**
   * `watch`: treat the link as dead after two missed heartbeats. HTTP has no lasting link, and
   * NapCat may not post heartbeats there, so HTTP mode turns it off.
   */
  constructor(private ctx: Context, private link: OneBotLink, private onDead: () => void, private watch = true) {
    this.logger = ctx.logger('onebot')
    this.touch()
  }

  /** A connection over an open WebSocket: frames in, and the socket closing ends it. */
  static overSocket(ctx: Context, socket: WebSocket, onDead: () => void) {
    const connection = new OneBotConnection(ctx, {
      send: (frame, done) => socket.send(frame, done),
      close: () => socket.terminate(),
    }, onDead)
    socket.on('message', (data) => connection.receive(data.toString()))
    socket.on('close', () => connection.dispose(new Error('connection closed')))
    return connection
  }

  /** Resets the heartbeat watchdog; a silent connection is treated as dead after two missed beats. */
  private touch() {
    if (!this.watch) return
    clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => {
      this.logger.warn('no heartbeat from %s for %ds, reconnecting', this.ctx.bot.record.name, (this.heartbeatInterval * 2) / 1000)
      this.link.close()
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
    if (this.link.request) {
      return this.link.request(action, params).then((response) => {
        if (response.status === 'failed' || (response.retcode !== 0 && response.retcode !== 1)) throw new OneBotError(action, response)
        return response.data
      })
    }
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
      this.link.send!(JSON.stringify({ action, params, echo }), (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(error)
      })
    })
  }

  async send(channel: ChannelInfo, segments: Segment[]) {
    const message = segments.map(toOneBotSegment)
    // A temporary chat needs its source group, or NapCat may fail to find the person when they are not a friend.
    const data = channel.type === 'group'
      ? await this.call('send_group_msg', { group_id: toId(channel.id), message })
      : await this.call('send_private_msg', { user_id: toId(channel.id), message, ...(channel.fromGroup ? { group_id: toId(channel.fromGroup) } : {}) })
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

  /** Handles one frame or posted event from NapCat. */
  receive(text: string) {
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
        return this.handleEvent(payload)
      // message_sent (NapCat's reportSelfMessage) echoes our own sends; they are recorded on send.
    }
  }

  private handleEvent(payload: any) {
    if (payload.notice_type === 'bot_offline') {
      // NapCat: the QQ account was logged out, e.g. kicked by a login elsewhere. The socket stays open.
      this.markAccount(false, String(payload.message || payload.tag || 'the QQ account went offline'))
    }
    const event = normalizeEvent(payload)
    if (event.name === 'group_recall' || event.name === 'friend_recall') {
      return this.withRecalled(event).then((full) => this.ctx.bot.dispatchEvent(full))
    }
    this.ctx.bot.dispatchEvent(event)
  }

  /** Adds the text of a recalled message from the bot's recent messages, when it is still there. */
  private async withRecalled(event: ReturnType<typeof normalizeEvent>) {
    const id = String(event.data.message_id ?? '')
    const bots = this.ctx.get('bots')
    if (!id || !bots) return event
    try {
      const records = await bots.messages(this.ctx.bot.id, { limit: 1000 })
      const record = records.findLast((item) => item.messageId === id)
      if (record) event.message = { id, text: segmentsToText(record.segments, true).trim(), segments: record.segments }
    } catch (error) {
      this.logger.debug('cannot look up recalled message %s: %s', id, error)
    }
    return event
  }

  /** Tracks whether NapCat's QQ account is logged in, from heartbeats and bot_offline notices. */
  private markAccount(online: boolean, reason = 'NapCat reports the QQ account offline') {
    if (!online) {
      if (this.accountOffline) return
      this.accountOffline = reason
      this.logger.warn('QQ account offline: %s', reason)
      this.ctx.bot.setStatus('error', `QQ account offline: ${reason}`)
      return
    }
    if (!this.accountOffline) return
    this.accountOffline = undefined
    this.logger.info('QQ account back online')
    this.ctx.bot.setStatus('online')
  }

  private handleMeta(payload: any) {
    if (payload.meta_event_type === 'heartbeat') {
      if (typeof payload.interval === 'number' && payload.interval > 0) {
        this.heartbeatInterval = payload.interval
        this.touch()
      }
      // OneBot 11: status.online is false when the account cannot send or receive.
      if (payload.status?.online === false) this.markAccount(false)
      else if (payload.status?.online === true) this.markAccount(true)
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
    // A private message with sub_type "group" is a temporary chat started from group_id.
    const fromGroup = payload.message_type === 'private' && payload.sub_type === 'group' && payload.group_id ? String(payload.group_id) : undefined
    const channel: ChannelInfo = payload.message_type === 'group'
      ? { type: 'group', id: String(payload.group_id), ...(payload.group_name ? { name: String(payload.group_name) } : {}) }
      : { type: 'private', id: userId, ...(sender.nickname ? { name: String(sender.nickname) } : {}), ...(fromGroup ? { fromGroup } : {}) }
    const user: UserInfo = { id: userId, name: sender.card || sender.nickname || undefined }
    if (sender.role === 'owner' || sender.role === 'admin' || sender.role === 'member') user.role = sender.role
    this.ctx.bot.receive({
      messageId: payload.message_id !== undefined ? String(payload.message_id) : undefined,
      channel,
      user,
      segments,
      timestamp: typeof payload.time === 'number' ? payload.time * 1000 : Date.now(),
    }).catch((error) => this.logger.warn('failed to handle message: %s', error))
  }
}
