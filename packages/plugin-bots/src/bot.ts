import {
  type ChannelInfo, type Content, Context, type MessageRecord, type Provenance, type Segment, segmentsToText,
  randomId, Service, seg, toSegments, usage, type UsageEvent, type UsageScope, type UserInfo,
} from '@mushinjs/core'
import {
  type ArgValue, type CommandDef, type CommandEntry, commandMatches, DEFAULT_PREFIXES, parseArgs, type ParsedCommand, requiredRole, splitCommand,
  usageReply,
} from './commands'
import {
  type BotEvent, type BotRecord, type BotRole, type BotStatus, type ContactResolver, type GroupRole, type GroupRoleResolver, type IncomingMessage, isSandbox,
  type MediaResolver, roleAtLeast, SANDBOX_CHANNEL, SANDBOX_USER, type SourcedContent, type Transport,
} from './types'

export type Sendable = Content | SourcedContent

export type Middleware = (session: Session, next: () => Promise<void>) => Promise<void> | void

interface MiddlewareEntry {
  plugin: string
  callback: Middleware
  priority: number
}

export interface MiddlewareOptions {
  /** Higher runs earlier; plugins with the same priority run in registration order. Default 0. */
  priority?: number
}

/** Supplied by the bot manager: `record` stores and broadcasts a message, `status` reports changes. */
export interface BotHooks {
  record(record: Omit<MessageRecord, 'id' | 'type' | 'platforms'>): MessageRecord
  status(bot: Bot): void
  /** Every command registered on this bot, from flows, plugins and the built-in help. */
  commands?(bot: Bot): CommandEntry[]
  /** A message ran a registered command. */
  commandCalled?(bot: Bot, entry: CommandEntry, session: Session): void
  /** The answer to a built-in command such as `/help`. */
  builtinCommand?(bot: Bot, entry: CommandEntry, session: Session): string | undefined
  /** The sender's role on this bot; nothing when the permissions plugin is not running. */
  roleOf?(bot: Bot, userId: string): BotRole | undefined
  /** A command that an app plugin answers on every bot, such as `/persona`. */
  appCommand?(bot: Bot, entry: CommandEntry): ((session: Session) => Promise<unknown> | unknown) | undefined
  /** Where the costs of handling a message go; see `usage` in core. */
  usageScope?(bot: Bot, record: MessageRecord): UsageScope | undefined
  /** An outgoing message was sent: its size, how long the platform took (not for the sandbox), and the message being handled. */
  sent?(bot: Bot, record: MessageRecord, transfer: { bytes: number; ms?: number; cause?: string }): void
}

export type CommandHandler = (session: Session, args: Record<string, ArgValue>, command: ParsedCommand) => Promise<unknown> | unknown

/** Replies from built-in commands such as `/help` are attributed to the bots plugin. */
const BUILTIN_PLUGIN = 'bots'
/** Built-in commands answer after flows (priority 10) and before plugins with the default priority. */
export const BUILTIN_PRIORITY = 5

function isSourced(value: Sendable): value is SourcedContent {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !('type' in value)
}

/** One incoming message, as seen by a bot plugin's middleware. */
export class Session {
  /** Name of the plugin whose middleware is handling this session; replies are attributed to it. */
  plugin?: string
  private parsed?: { value: ParsedCommand | undefined }

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

  /** The command this message runs, such as `/score 85`, split by the bot's prefixes. */
  get command(): ParsedCommand | undefined {
    // Read once when the message arrives, before plugin views of the session exist, so they share it.
    this.parsed ??= { value: this.bot.parseCommand(this.text) }
    return this.parsed.value
  }

  /** The sender's role on this bot (master, admin or user); nothing when the permissions plugin is off. */
  role(): BotRole | undefined {
    return this.bot.roleOf(this.user.id)
  }

  /** The sender's role in this group, when the adapter can tell; nothing in private chats. */
  groupRole(): Promise<GroupRole | undefined> {
    return this.bot.groupRoleOf({ channel: this.channel, user: this.user })
  }

  /** True when the sender is an admin or master of the bot, who may run admin-only commands. */
  get isAdmin() {
    return roleAtLeast(this.role(), 'admin')
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
  /** The account's picture, as a URL the dashboard can load; adapters set it when the platform has one. */
  selfAvatar?: string
  record: BotRecord
  private hooks: BotHooks
  private transport?: Transport
  private middlewares: MiddlewareEntry[] = []
  private eventHandlers = new Set<(event: BotEvent) => void>()
  private ownCommands = new Set<{ def: CommandDef; plugin: string }>()
  private commandProviders = new Set<() => CommandEntry[]>()
  private roleResolver?: GroupRoleResolver
  private mediaResolver?: MediaResolver
  private contactResolver?: ContactResolver

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

  setSelf(id: string, name?: string, avatar?: string) {
    this.selfId = id
    this.selfName = name
    this.selfAvatar = avatar
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

  /** Called by adapters that can tell a sender's group role (owner, admin, member). */
  useRoleResolver(resolver: GroupRoleResolver) {
    return this.ctx.effect(() => {
      this.roleResolver = resolver
      return () => {
        if (this.roleResolver === resolver) this.roleResolver = undefined
      }
    }, 'bot.useRoleResolver()')
  }

  /** Called by adapters that can fetch a message's media and forwarded chat histories. */
  useMediaResolver(resolver: MediaResolver) {
    return this.ctx.effect(() => {
      this.mediaResolver = resolver
      return () => {
        if (this.mediaResolver === resolver) this.mediaResolver = undefined
      }
    }, 'bot.useMediaResolver()')
  }

  /** Called by adapters that can list the account's friends and groups. */
  useContacts(resolver: ContactResolver) {
    return this.ctx.effect(() => {
      this.contactResolver = resolver
      return () => {
        if (this.contactResolver === resolver) this.contactResolver = undefined
      }
    }, 'bot.useContacts()')
  }

  /** The account's friends and groups; empty when the adapter cannot list them. */
  async contacts() {
    return this.contactResolver ? this.contactResolver() : []
  }

  /**
   * A message from the sandbox's test user, as if they wrote it to the bot in a private chat. A
   * leading "@" mentions the bot. Replies stay in the sandbox and never reach the platform.
   */
  sandbox(text: string) {
    const mention = /^@\S*\s*/.exec(text)
    const rest = mention ? text.slice(mention[0].length) : text
    const segments: Segment[] = [
      ...(mention ? [seg.at(this.selfId ?? this.id, this.selfName ?? this.record.name)] : []),
      ...(rest ? [seg.text(mention ? ` ${rest}` : rest)] : []),
    ]
    // Not awaited: a flow may wait for the next message, which comes through another call.
    this.receive({ messageId: randomId(6), channel: SANDBOX_CHANNEL, user: SANDBOX_USER, segments }).catch((error) => {
      this.ctx.logger('bot').warn('sandbox message failed: %s', error)
    })
  }

  /** An address for an image, video, voice or file segment; see `MediaResolver.media`. */
  async media(segment: Segment, options: { channel?: ChannelInfo; inline?: boolean } = {}) {
    if (!this.mediaResolver?.media) throw new Error(`the ${this.platform} adapter cannot fetch media`)
    return this.mediaResolver.media(segment, { channel: options.channel, inline: options.inline ?? false })
  }

  /** The messages of a forwarded chat history. */
  async forward(id: string) {
    if (!this.mediaResolver?.forward) throw new Error(`the ${this.platform} adapter cannot read forwarded messages`)
    return this.mediaResolver.forward(id)
  }

  /** The user's role on this bot, from the permissions plugin; nothing when it is not running. */
  roleOf(userId: string): BotRole | undefined {
    // Whoever plays the sandbox's test user is signed in to the dashboard, so they own the bot.
    if (userId === SANDBOX_USER.id) return 'master'
    return this.hooks.roleOf?.(this, userId)
  }

  /** A sender's group role: from the message when the platform sent it, else from the adapter. */
  async groupRoleOf(target: { channel: ChannelInfo; user: { id: string; role?: GroupRole } }): Promise<GroupRole | undefined> {
    if (target.channel.type !== 'group' || !target.user.id) return
    if (target.user.role) return target.user.role
    try {
      return await this.roleResolver?.({ channel: target.channel, user: target.user })
    } catch (error) {
      this.ctx.logger('bot').debug('group role of %s: %s', target.user.id, error)
    }
  }

  /** Whether a command's role requirement lets this session run it; logs why not. */
  allows(def: Pick<CommandDef, 'name' | 'permission' | 'role'>, session: Session) {
    const required = requiredRole(def)
    if (!required) return true
    const role = session.role()
    if (role === undefined) {
      this.ctx.logger('bot').debug('/%s needs %s, but the permissions plugin is not running; ignored', def.name, required)
      return false
    }
    return roleAtLeast(role, required)
  }

  /** Registers middleware for incoming messages; runs in registration order. */
  middleware(callback: Middleware, options: MiddlewareOptions = {}) {
    const ctx = this.ctx
    const entry: MiddlewareEntry = { plugin: ctx.fiber.name, callback, priority: options.priority ?? 0 }
    return ctx.effect(() => {
      // Insert after every entry with the same or higher priority, keeping registration order within a priority.
      const index = this.middlewares.findIndex((item) => item.priority < entry.priority)
      if (index < 0) this.middlewares.push(entry)
      else this.middlewares.splice(index, 0, entry)
      return () => {
        const index = this.middlewares.indexOf(entry)
        if (index >= 0) this.middlewares.splice(index, 1)
      }
    }, 'bot.middleware()')
  }

  get prefixes() {
    const prefixes = this.record.commands?.prefixes?.filter(Boolean)
    return prefixes?.length ? prefixes : DEFAULT_PREFIXES
  }

  /**
   * Splits text into a command, with the registered command it names. Commands with prefixes of
   * their own (such as `#`) are matched by those only; the rest by the bot's prefixes.
   */
  parseCommand(text: string): ParsedCommand | undefined {
    const entries = this.hooks.commands?.(this) ?? []
    for (const entry of entries) {
      if (!entry.prefixes?.length) continue
      const parsed = splitCommand(text, entry.prefixes)
      if (parsed && commandMatches(entry, parsed.name)) return { ...parsed, entry }
    }
    const parsed = splitCommand(text, this.prefixes)
    if (!parsed) return
    const entry = entries.find((item) => !item.prefixes?.length && commandMatches(item, parsed.name))
    return entry ? { ...parsed, entry } : parsed
  }

  /** Commands that plugins of this bot registered with `bot.command()` or `bot.defineCommands()`. */
  localCommands(): CommandEntry[] {
    const entries: CommandEntry[] = [...this.ownCommands].map(({ def, plugin }) => ({ ...def, botId: this.id, source: { kind: 'plugin', id: plugin, name: plugin } }))
    for (const provider of this.commandProviders) {
      try {
        entries.push(...provider())
      } catch (error) {
        this.ctx.logger('bot').warn('listing commands failed: %s', error)
      }
    }
    return entries
  }

  /**
   * Lists commands that a plugin answers itself, e.g. the command nodes of the flows on this bot,
   * so they show in `/help` and the command list. Removed when the calling plugin unloads.
   */
  defineCommands(provider: () => CommandEntry[]) {
    return this.ctx.effect(() => {
      this.commandProviders.add(provider)
      return () => this.commandProviders.delete(provider)
    }, 'bot.defineCommands()')
  }

  /**
   * Registers a command, e.g. `bot.command({ name: 'roll', args: [{ name: 'sides', type: 'number', optional: true }] }, handler)`.
   * It shows in `/help`, and the handler gets the parsed arguments; when they do not fit, the bot
   * replies with how to write the command.
   */
  command(def: CommandDef, handler: CommandHandler) {
    const ctx = this.ctx
    const entry = { def, plugin: ctx.fiber.name }
    ctx.effect(() => {
      this.ownCommands.add(entry)
      return () => this.ownCommands.delete(entry)
    }, `bot.command(${def.name})`)
    return this.middleware(async (session, next) => {
      const parsed = session.command
      if (!parsed || !commandMatches(def, parsed.name)) return next()
      if (def.prefixes?.length ? !def.prefixes.includes(parsed.prefix) : parsed.entry?.prefixes?.length) return next()
      if (!this.allows(def, session)) return
      const values = parseArgs(def.args ?? [], parsed.rest, session.segments)
      if (!values.ok) {
        await session.reply(usageReply(def, parsed.prefix))
        return
      }
      await handler(session, values.values, parsed)
    })
  }

  /** The plugins whose middleware sees incoming messages, in the order they see them. */
  middlewareOrder() {
    return this.middlewares.map(({ plugin, priority }) => ({ plugin, priority }))
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
    this.logEvent(event)
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (error) {
        this.ctx.logger('bot').warn(error)
      }
    }
  }

  /** Called by adapters for each incoming message: records it, then runs the middleware chain. */
  async receive(message: IncomingMessage, options: { source?: Provenance } = {}) {
    const started = Date.now()
    const record = this.hooks.record({
      botId: this.id,
      messageId: message.messageId,
      direction: 'in',
      channel: message.channel,
      user: message.user,
      segments: message.segments,
      timestamp: message.timestamp ?? Date.now(),
      source: options.source ?? { kind: 'user' },
    })
    this.ctx.logger('message').info('received from %s%s: %s', who(record.user), record.channel.type === 'group' ? ` in ${chat(record.channel)}` : '', preview(record.segments))
    const session = new Session(this, record)
    const entry = session.command?.entry
    if (entry) {
      try {
        this.hooks.commandCalled?.(this, entry, session)
      } catch {}
    }
    const chain = [...this.middlewares]
    const appHandler = entry?.source.kind === 'plugin' ? this.hooks.appCommand?.(this, entry) : undefined
    if (entry?.source.kind === 'builtin' || appHandler) {
      // After flows, so a flow that answers the same text (say a keyword trigger on /help) still wins.
      const builtin: MiddlewareEntry = {
        plugin: appHandler ? entry!.source.id : BUILTIN_PLUGIN,
        priority: BUILTIN_PRIORITY,
        callback: async (view, next) => {
          if (!this.allows(entry!, view)) return next()
          if (appHandler) {
            await appHandler(view)
            return
          }
          const answer = this.hooks.builtinCommand?.(this, entry!, view)
          if (answer !== undefined) await view.reply(answer)
        },
      }
      const index = chain.findIndex((item) => item.priority < builtin.priority)
      chain.splice(index < 0 ? chain.length : index, 0, builtin)
    }
    /** The plugin that kept the message from the ones after it, if one did. */
    let stoppedAt: string | undefined
    const run = async (index: number): Promise<void> => {
      const entry = chain[index]
      if (!entry) return
      let passed = false
      try {
        await entry.callback(session.as(entry.plugin), () => {
          passed = true
          return run(index + 1)
        })
        if (!passed && index < chain.length - 1) stoppedAt ??= entry.plugin
      } catch (error) {
        this.ctx.logger('bot').warn('middleware of %s failed: %s', entry.plugin, error)
      }
    }
    const outer = this.hooks.usageScope?.(this, record)
    const scope: UsageScope = {
      botId: this.id,
      messageId: record.id,
      report: (event) => {
        outer?.report(event)
        this.logUsage(event)
      },
    }
    await usage.run(scope, () => run(0))
    this.ctx.logger('bot').info('processed in %s%s', duration(Date.now() - started), stoppedAt ? `; ${stoppedAt} kept it from the plugins after it` : '')
    return session
  }

  /**
   * A notice or request from the platform (a poke, a member joining, a recall…) as a line in the
   * bot's log. Typing indicators come often and say little, so they and unnamed events are debug lines.
   */
  private logEvent(event: BotEvent) {
    const name = event.name ?? event.type
    const target = event.data?.target_id ?? undefined
    const parts = [
      event.user && `from ${who(event.user)}`,
      event.channel?.type === 'group' && `in ${chat(event.channel)}`,
      target !== undefined && target !== null && `to ${target}`,
      event.message?.text && `: ${preview(event.message.segments)}`,
    ].filter(Boolean).join(' ').replace(' :', ':')
    const quiet = !event.name || event.name === 'notify.input_status'
    this.ctx.logger('message')[quiet ? 'debug' : 'info']('event %s%s', name, parts ? ` ${parts}` : '')
  }

  /** A model request or a plugin's own work made while handling a message, as a line in the bot's log. */
  private logUsage(event: UsageEvent) {
    const logger = this.ctx.logger('llm')
    const target = [event.model, event.provider && `via ${event.provider}`, event.plugin && `for ${event.plugin}`].filter(Boolean).join(' ')
    const tokens = event.inputTokens !== undefined || event.outputTokens !== undefined
      ? `${event.inputTokens ?? '?'} → ${event.outputTokens ?? 0} tokens` : ''
    const details = [tokens, event.note, event.latencyMs !== undefined && duration(event.latencyMs)].filter(Boolean).join(', ')
    if (event.ok === false) logger.warn('%s %s failed%s', event.kind, target, event.latencyMs !== undefined ? ` after ${duration(event.latencyMs)}` : '')
    else logger.info('%s %s%s', event.kind, target, details ? `: ${details}` : '')
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
    const sandbox = isSandbox(channel)
    if (!this.transport && !sandbox) throw new Error(`bot ${this.record.name} is not connected`)
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
    const started = Date.now()
    const logger = this.ctx.logger('message')
    const sender = source.kind === 'flow' ? `flow ${source.flow}` : source.kind === 'plugin' || source.kind === 'llm' ? source.plugin : undefined
    let messageId: string | undefined
    try {
      ;({ messageId } = sandbox ? { messageId: randomId(6) } : await this.transport!.send(channel, segments))
    } catch (error) {
      logger.warn('sending to %s failed: %s', chat(channel), error instanceof Error ? error.message : error)
      throw error
    }
    const ms = Date.now() - started
    const bytes = byteSize(segments)
    logger.info('sent to %s%s: %s (%s%s)', chat(channel), sender ? ` by ${sender}` : '', preview(segments), size(bytes), sandbox ? '' : `, ${duration(ms)}`)
    const record = this.hooks.record({
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
    this.hooks.sent?.(this, record, { bytes, ...(sandbox ? {} : { ms }), cause: usage.current()?.messageId })
    return record
  }
}

/** How big a message is on the wire, roughly: its segments as JSON. Inline images count in full. */
export function byteSize(segments: Segment[]) {
  return Buffer.byteLength(JSON.stringify(segments))
}

/** A message on one line for the bot's log, cut to a readable length. */
function preview(segments: Segment[]) {
  const text = segmentsToText(segments).replace(/\s+/g, ' ').trim()
  return text.length > 200 ? `${text.slice(0, 200)}…` : text || '(empty)'
}

/** A chat for the bot's log: `group Tea room (500)`, a person for a private chat, or the sandbox. */
function chat(channel: ChannelInfo) {
  if (isSandbox(channel)) return 'the sandbox'
  const name = channel.name ? `${channel.name} (${channel.id})` : channel.id
  return channel.type === 'group' ? `group ${name}` : name
}

function who(user: UserInfo) {
  return user.name ? `${user.name} (${user.id})` : user.id
}

function duration(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`
}

function size(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}
