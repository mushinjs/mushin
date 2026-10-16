import {
  type ChannelInfo, type Content, Context, type MessageRecord, type Provenance, type Segment, segmentsToText,
  Service, toSegments,
} from '@mushin/core'
import type { BotEvent, BotRecord, BotStatus, IncomingMessage, SourcedContent, Transport } from './types'

export type Sendable = Content | SourcedContent

export type Middleware = (session: Session, next: () => Promise<void>) => Promise<void> | void

interface MiddlewareEntry {
  plugin: string
  callback: Middleware
}

/** Supplied by the bot manager: `record` stores and broadcasts a message, `status` reports changes. */
export interface BotHooks {
  record(record: Omit<MessageRecord, 'id' | 'type' | 'platforms'>): MessageRecord
  status(bot: Bot): void
}

function isSourced(value: Sendable): value is SourcedContent {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !('type' in value)
}

/** One incoming message, as seen by a bot plugin's middleware. */
export class Session {
  /** Name of the plugin whose middleware is handling this session; replies are attributed to it. */
  plugin?: string

  constructor(public bot: Bot, public record: MessageRecord) {}

  get channel() {
    return this.record.channel
  }

  get user() {
    return this.record.user
  }

  get segments() {
    return this.record.segments
  }

  get isDirect() {
    return this.record.channel.type === 'private'
  }

  /** True when the message @-mentions this bot. */
  get mentioned() {
    return this.segments.some((s) => s.type === 'at' && String(s.data.qq) === this.bot.selfId)
  }

  /** Plain text with mentions of this bot removed. */
  get text() {
    const segments = this.segments.filter((s) => !(s.type === 'at' && String(s.data.qq) === this.bot.selfId))
    return segmentsToText(segments).trim()
  }

  send(content: Sendable) {
    return this.bot.deliver(this.channel, content, { plugin: this.plugin, replyTo: this.record.id })
  }

  /** Sends with a reply reference to the incoming message, when the platform supports it. */
  reply(content: Sendable) {
    const quote: Segment[] = this.record.messageId ? [{ type: 'reply', data: { id: this.record.messageId } }] : []
    if (isSourced(content)) {
      return this.send({ ...content, segments: [...quote, ...(content.segments ?? toSegments(content.text ?? ''))] })
    }
    return this.send([...quote, ...toSegments(content)])
  }

  /** A view of this session attributed to another plugin. */
  as(plugin: string) {
    const view = Object.create(this) as Session
    view.plugin = plugin
    return view
  }
}

/**
 * The `bot` service. Each bot runs in its own isolated context, so `ctx.bot` in a bot plugin
 * always means that plugin's bot.
 */
export class Bot extends Service {
  status: BotStatus = 'offline'
  error?: string
  selfId?: string
  selfName?: string
  record: BotRecord
  private hooks: BotHooks
  private transport?: Transport
  private middlewares: MiddlewareEntry[] = []
  private eventHandlers = new Set<(event: BotEvent) => void>()

  constructor(ctx: Context, config: { record: BotRecord; hooks: BotHooks }) {
    super(ctx, 'bot')
    this.record = config.record
    this.hooks = config.hooks
  }

  get id() {
    return this.record.id
  }

  get platform() {
    return this.record.adapter.type
  }

  setStatus(status: BotStatus, error?: string) {
    const nextError = status === 'error' ? error : undefined
    if (status !== this.status || nextError !== this.error) {
      const logger = this.ctx.logger('bot')
      if (status === 'error') logger.warn('status: error (%s)', error ?? 'no details')
      else logger.info('status: %s', status)
    }
    this.status = status
    this.error = status === 'error' ? error : undefined
    this.hooks.status(this)
  }

  setSelf(id: string, name?: string) {
    this.selfId = id
    this.selfName = name
    this.hooks.status(this)
  }

  /** Called by adapters. Removed, and the bot marked offline, when the adapter unloads. */
  useTransport(transport: Transport) {
    return this.ctx.effect(() => {
      this.transport = transport
      return () => {
        if (this.transport !== transport) return
        this.transport = undefined
        this.setStatus('offline')
      }
    }, 'bot.useTransport()')
  }

  /** Registers middleware for incoming messages; runs in registration order. */
  middleware(callback: Middleware) {
    const ctx = this.ctx
    const entry = { plugin: ctx.fiber.name, callback }
    return ctx.effect(() => {
      this.middlewares.push(entry)
      return () => {
        const index = this.middlewares.indexOf(entry)
        if (index >= 0) this.middlewares.splice(index, 1)
      }
    }, 'bot.middleware()')
  }

  /** Listens for adapter events that are not messages (notices, requests). */
  onEvent(handler: (event: BotEvent) => void) {
    return this.ctx.effect(() => {
      this.eventHandlers.add(handler)
      return () => this.eventHandlers.delete(handler)
    }, 'bot.onEvent()')
  }

  /** Called by adapters for non-message events. */
  dispatchEvent(event: BotEvent) {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (error) {
        this.ctx.logger('bot').warn(error)
      }
    }
  }

  /** Called by adapters for each incoming message: records it, then runs the middleware chain. */
  async receive(message: IncomingMessage) {
    const record = this.hooks.record({
      botId: this.id,
      messageId: message.messageId,
      direction: 'in',
      channel: message.channel,
      user: message.user,
      segments: message.segments,
      timestamp: message.timestamp ?? Date.now(),
      source: { kind: 'user' },
    })
    const session = new Session(this, record)
    const chain = [...this.middlewares]
    const run = async (index: number): Promise<void> => {
      const entry = chain[index]
      if (!entry) return
      try {
        await entry.callback(session.as(entry.plugin), () => run(index + 1))
      } catch (error) {
        this.ctx.logger('bot').warn('middleware of %s failed: %s', entry.plugin, error)
      }
    }
    await run(0)
    return session
  }

  /** Sends a message from a plugin; the reply is attributed to the calling plugin. */
  send(channel: ChannelInfo, content: Sendable, options: { source?: Provenance } = {}) {
    return this.deliver(channel, content, { plugin: this.ctx.fiber.name, source: options.source })
  }

  /** Raw adapter API, e.g. a NapCat extension action. */
  async call(action: string, params: Record<string, any> = {}) {
    if (!this.transport?.call) throw new Error(`bot ${this.record.name} has no API transport`)
    return this.transport.call(action, params)
  }

  async deliver(
    channel: ChannelInfo,
    content: Sendable,
    options: { plugin?: string; source?: Provenance; replyTo?: string },
  ) {
    if (!this.transport) throw new Error(`bot ${this.record.name} is not connected`)
    let segments: Segment[]
    let source: Provenance | undefined = options.source
    if (isSourced(content)) {
      segments = content.segments ?? toSegments(content.text ?? '')
      source ??= content.source
    } else {
      segments = toSegments(content)
    }
    if (source?.kind === 'llm' && !source.plugin && options.plugin) source = { ...source, plugin: options.plugin }
    source ??= options.plugin ? { kind: 'plugin', plugin: options.plugin } : { kind: 'manual' }
    if (!segments.length || (segments.length === 1 && segments[0].type === 'text' && !segments[0].data.text)) {
      return
    }
    const { messageId } = await this.transport.send(channel, segments)
    return this.hooks.record({
      botId: this.id,
      messageId,
      direction: 'out',
      channel,
      user: { id: this.selfId ?? this.id, name: this.selfName ?? this.record.name },
      segments,
      timestamp: Date.now(),
      replyTo: options.replyTo,
      source,
    })
  }
}
