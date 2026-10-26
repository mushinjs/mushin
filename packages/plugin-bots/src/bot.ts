import {
  type ChannelInfo, type Content, Context, type MessageRecord, type Provenance, type Segment, segmentsToText,
  Service, toSegments,
} from '@mushin/core'
import {
  type CommandDef, type CommandEntry, commandMatches, DEFAULT_PREFIXES, parseArgs, type ParsedCommand, parseSignature, requiredRole, splitCommand,
  usageReply,
} from './commands'
import {
  type BotEvent, type BotRecord, type BotRole, type BotStatus, type GroupRole, type GroupRoleResolver, type IncomingMessage, roleAtLeast,
  type SourcedContent, type Transport,
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
}

export type CommandHandler = (session: Session, args: Record<string, string | number>, command: ParsedCommand) => Promise<unknown> | unknown

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
  record: BotRecord
  private hooks: BotHooks
  private transport?: Transport
  private middlewares: MiddlewareEntry[] = []
  private eventHandlers = new Set<(event: BotEvent) => void>()
  private ownCommands = new Set<{ def: CommandDef; plugin: string }>()
  private commandProviders = new Set<() => CommandEntry[]>()
  private roleResolver?: GroupRoleResolver

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

  /** Called by adapters that can tell a sender's group role (owner, admin, member). */
  useRoleResolver(resolver: GroupRoleResolver) {
    return this.ctx.effect(() => {
      this.roleResolver = resolver
      return () => {
        if (this.roleResolver === resolver) this.roleResolver = undefined
      }
    }, 'bot.useRoleResolver()')
  }

  /** The user's role on this bot, from the permissions plugin; nothing when it is not running. */
  roleOf(userId: string): BotRole | undefined {
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

  /** Splits text into a command by this bot's prefixes, with the registered command it names. */
  parseCommand(text: string): ParsedCommand | undefined {
    const parsed = splitCommand(text, this.prefixes)
    if (!parsed) return
    const entry = this.hooks.commands?.(this).find((item) => commandMatches(item, parsed.name))
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
   * Registers a command, e.g. `bot.command({ name: 'roll', usage: '[sides:number]' }, handler)`.
   * It shows in `/help`, and the handler gets the parsed arguments; when they do not fit the
   * usage, the bot replies with how to write the command.
   */
  command(def: CommandDef, handler: CommandHandler) {
    const ctx = this.ctx
    const entry = { def, plugin: ctx.fiber.name }
    const args = parseSignature(def.usage)
    ctx.effect(() => {
      this.ownCommands.add(entry)
      return () => this.ownCommands.delete(entry)
    }, `bot.command(${def.name})`)
    return this.middleware(async (session, next) => {
      const parsed = session.command
      if (!parsed || !commandMatches(def, parsed.name)) return next()
      if (!this.allows(def, session)) return
      const values = parseArgs(args, parsed.rest)
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
