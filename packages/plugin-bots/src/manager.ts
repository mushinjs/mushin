import {
  type ChannelInfo, Context, describeMissing, dependencyReport, type LogTag, type MissingDependency, logTag, type Exporter, type Fiber, fiberError, fiberStatus, isMasked, Logger, mask, type Message,
  type MessageRecord, messageType, MushinError, type Plugin, type Provenance, pluginSchema, randomId, type Segment, segmentsToText, Service, toJsonSchema,
  validatePluginConfig, z,
} from '@mushin/core'
import type {} from '@mushin/plugin-storage'
import { MessageArchive } from './archive'
import { Bot, type BotHooks, type Session } from './bot'
import { type CommandDef, type CommandEntry, commandConflicts, type CommandSettings, commandMatches, helpText, requiredRole } from './commands'
import { type AdapterType, type BotPluginEntry, type BotRecord, type BotStatus, type PermissionProvider, roleAtLeast } from './types'

declare module '@mushin/core' {
  interface Context {
    bots: BotManager
    bot: Bot
  }

  interface Events {
    'bots/changed'(): void
    'bots/status'(status: BotStatusInfo): void
    'bots/message'(record: MessageRecord): void
    'bots/log'(line: BotLogLine): void
    'bots/command'(call: CommandCall): void
  }
}

/** One log line written inside a bot's context: its adapter, its plugins, or the bot service itself. */
export interface BotLogLine {
  botId: string
  sn: number
  ts: number
  type: string
  name: string
  tag: LogTag
  text: string
}

/** A message ran a registered command. */
export interface CommandCall {
  botId: string
  name: string
  source: CommandEntry['source']
  userId: string
  channel: ChannelInfo
  at: number
}

export interface RunCommandInput {
  bot: string
  command: string
  target?: 'master' | 'group'
  group?: string
  user?: string
}

/** Lists commands a plugin provides on a bot, e.g. the command nodes of the flows attached to it. */
export type CommandProvider = (botId: string) => CommandEntry[]

/** A command an app plugin answers on every bot, or on the bots `bots` picks. */
interface AppCommand {
  def: CommandDef
  plugin: string
  handler: (session: Session) => Promise<unknown> | unknown
  bots?: (botId: string) => boolean
}

export interface BotStatusInfo {
  id: string
  status: BotStatus
  error?: string
  selfId?: string
  selfName?: string
}

interface Runtime {
  fiber?: Fiber
  ctx?: Context
  bot?: Bot
  plugins: Map<string, Fiber>
  pluginErrors: Map<string, string>
  /** Last connection status written to the global log. */
  logged?: BotStatus
}

const STORAGE_KEY = 'bots'
const BUFFER_SIZE = 500
const LOG_BUFFER_SIZE = 500
// Bot logs include debug lines (e.g. why llm-chat skipped a message); the main log stream does not.
const LOG_LEVEL_DEBUG = 3
const plainExporter: Exporter = { colors: false, export() {} }

const adapterInput = z.object({
  type: z.string().describe('Adapter type id from bots.adapters, e.g. "onebot"'),
  config: z.record(z.string(), z.any()).describe('Adapter config matching the schema from bots.adapters'),
})

const idInput = z.object({ id: z.string().describe('Bot id from bots.list') })
const commandSettingsInput = z.object({
  prefixes: z.array(z.string().min(1)).optional().describe('Command prefixes; default ["/"]'),
  help: z.boolean().optional().describe('Answer /help with the list of commands; on unless false'),
  helpTitle: z.string().optional().describe('First line of the /help menu'),
  admins: z.array(z.string()).optional().describe('Deprecated: admins now live in the permissions plugin (permissions.update)'),
  helpByRole: z.boolean().optional().describe('/help lists only the commands the asker may run'),
})

/** Answers `/help` when nothing else on the bot registers a command called help. */
const HELP_COMMAND = { name: 'help', description: '列出所有指令' }

const pluginInput = idInput.extend({ package: z.string().describe('Bot plugin package name from bots.plugins.list') })

/**
 * Owns bot records and runs each enabled bot in its own isolated context:
 * the `bot` service, the adapter connection and the bot's plugins live there.
 */
export class BotManager extends Service {
  static inject = ['storage', 'actions', 'manager']

  private home: Context
  private records: BotRecord[] = []
  private adapterStore = new Map<string, AdapterType>()
  private runtimes = new Map<string, Runtime>()
  private startErrors = new Map<string, string>()
  private buffers = new Map<string, MessageRecord[]>()
  /** Messages in the database, when the database plugin runs. */
  private archive?: MessageArchive
  /** Runtime fiber of each running bot, to attribute log lines to the bot that wrote them. */
  private runtimeFibers = new Map<Fiber, string>()
  private logs = new Map<string, BotLogLine[]>()
  /** Sequence numbers of recent bot log lines; still recognized after the bot that wrote them stops. */
  private botLogSns = new Set<number>()
  private commandProviders = new Set<CommandProvider>()
  private appCommands = new Set<AppCommand>()
  private permissionProvider?: PermissionProvider

  constructor(ctx: Context) {
    super(ctx, 'bots')
    this.home = ctx
  }

  /**
   * Bot lifecycle lines for the global log, tagged `bot` in the dashboard. Written from the manager's
   * own context, so they stay out of the bot's log, which has its own lines from inside the bot.
   */
  private get logger() {
    return this.home.logger('bot')
  }

  async *[Service.init]() {
    const stored = await this.home.storage.get<{ bots: BotRecord[] }>(STORAGE_KEY)
    this.records = stored?.bots ?? []
    this.logger.info('loaded %d bot(s)', this.records.length)
    yield this.home.logger.exporter({
      colors: false,
      levels: { default: LOG_LEVEL_DEBUG },
      export: (message) => this.captureLog(message),
    })
    yield* this.defineActions()
    this.home.inject(['model', 'database'], async (ctx) => {
      const archive = new MessageArchive(ctx, (error) => this.logger.warn('saving a message to the database failed: %s', error))
      this.archive = archive
      ctx.effect(() => () => {
        if (this.archive === archive) this.archive = undefined
      }, 'bots message archive')
      try {
        const imported = await archive.start()
        if (imported) this.logger.info('imported %d message(s) from the message logs into the database', imported)
      } catch (error) {
        this.logger.warn('importing the message logs into the database failed: %s', error)
        if (this.archive === archive) this.archive = undefined
      }
    })
    if (this.home.offline) this.logger.info('offline: bots are not started')
    for (const record of this.home.offline ? [] : this.records) {
      if (record.enabled && this.adapterStore.has(record.adapter.type)) this.startSafely(record.id)
    }
  }

  // ---- adapters ----

  /** Registers an adapter type. Bots using it start when it loads and stop when it unloads. */
  defineAdapter<C>(adapter: AdapterType<C>) {
    const ctx = this.ctx
    return ctx.effect(() => {
      if (this.adapterStore.has(adapter.id)) throw new Error(`adapter "${adapter.id}" is already defined`)
      this.adapterStore.set(adapter.id, adapter)
      this.logger.info('adapter %s is available', adapter.id)
      for (const record of this.records) {
        if (this.home.offline) break
        if (record.enabled && record.adapter.type === adapter.id && !this.runtimes.has(record.id)) {
          this.startSafely(record.id)
        }
      }
      ctx.emit('bots/changed')
      return async () => {
        this.adapterStore.delete(adapter.id)
        this.logger.info('adapter %s was removed', adapter.id)
        for (const record of this.records) {
          if (record.adapter.type !== adapter.id || !this.runtimes.has(record.id)) continue
          await this.stopRuntime(record.id)
          this.startErrors.set(record.id, `Adapter "${adapter.id}" was unloaded`)
          this.emitStatus(record.id)
        }
        ctx.emit('bots/changed')
      }
    }, `bots.defineAdapter(${adapter.id})`)
  }

  adapters() {
    return [...this.adapterStore.values()].map((adapter) => ({
      id: adapter.id,
      displayName: adapter.displayName,
      configSchema: toJsonSchema(adapter.config),
      secrets: adapter.secrets ?? [],
      segments: adapter.segments,
      groupRoles: !!adapter.groupRoles,
    }))
  }

  /** Adapters that can send every segment in a message. */
  platformsFor(segments: Segment[]) {
    return [...this.adapterStore.values()]
      .filter((adapter) => segments.every((s) => adapter.segments.includes(s.type)))
      .map((adapter) => adapter.id)
  }

  // ---- records ----

  get(id: string) {
    const record = this.records.find((item) => item.id === id)
    if (!record) throw new MushinError('not_found', `No bot with id "${id}"`)
    return record
  }

  bot(id: string) {
    return this.runtimes.get(id)?.bot
  }

  status(id: string): BotStatusInfo {
    const bot = this.bot(id)
    if (bot) return { id, status: bot.status, error: bot.error, selfId: bot.selfId, selfName: bot.selfName }
    const error = this.startErrors.get(id)
    return { id, status: error ? 'error' : 'offline', error }
  }

  private emitStatus(id: string) {
    this.home.emit('bots/status', this.status(id))
  }

  private redact(record: BotRecord) {
    const secrets = this.adapterStore.get(record.adapter.type)?.secrets ?? []
    const config = { ...record.adapter.config }
    for (const key of secrets) {
      if (typeof config[key] === 'string' && config[key]) config[key] = mask(config[key])
    }
    return { ...record, adapter: { ...record.adapter, config } }
  }

  describe(record: BotRecord) {
    return { ...this.redact(record), ...this.status(record.id), connection: this.connectionOf(record) }
  }

  private connectionOf(record: BotRecord) {
    try {
      return this.adapterStore.get(record.adapter.type)?.describe?.(record.adapter.config, record.id)
    } catch {}
  }

  list() {
    return this.records.map((record) => this.describe(record))
  }

  private async save() {
    await this.home.storage.set(STORAGE_KEY, { bots: this.records })
    this.home.emit('bots/changed')
  }

  private validateAdapter(type: string, config: unknown) {
    const adapter = this.adapterStore.get(type)
    if (!adapter) {
      const known = [...this.adapterStore.keys()].join(', ') || 'none'
      throw new MushinError('invalid_input', `Unknown adapter "${type}". Loaded adapters: ${known}`)
    }
    const result = adapter.config.safeParse(config)
    if (!result.success) throw new MushinError('invalid_input', z.prettifyError(result.error), result.error.issues)
    return result.data as Record<string, any>
  }

  async create(input: { name: string; adapter: { type: string; config: Record<string, any> }; plugins?: { package: string; config?: Record<string, any> }[]; enabled?: boolean; provider?: string; commands?: CommandSettings }) {
    const id = randomId()
    const record: BotRecord = {
      id,
      name: input.name,
      enabled: input.enabled ?? true,
      adapter: { type: input.adapter.type, config: this.validateAdapter(input.adapter.type, input.adapter.config) },
      plugins: [],
      provider: input.provider,
      ...(input.commands ? { commands: input.commands } : {}),
      createdAt: Date.now(),
    }
    for (const item of input.plugins ?? []) {
      const plugin = await this.loadBotPlugin(item.package)
      validatePluginConfig(plugin, item.config ?? {})
      record.plugins.push({ package: item.package, enabled: true, config: item.config ?? {} })
    }
    this.records.push(record)
    await this.save()
    this.logger.info('created bot %s', this.label(record))
    if (record.enabled) await this.start(id).catch(() => {})
    return this.describe(record)
  }

  async update(id: string, patch: { name?: string; adapter?: { type: string; config: Record<string, any> }; provider?: string | null; commands?: CommandSettings }) {
    const record = this.get(id)
    if (patch.commands !== undefined) record.commands = { ...record.commands, ...patch.commands }
    if (patch.name !== undefined) record.name = patch.name
    if (patch.provider !== undefined) record.provider = patch.provider ?? undefined
    if (patch.adapter) {
      const secrets = this.adapterStore.get(patch.adapter.type)?.secrets ?? []
      const config = { ...patch.adapter.config }
      for (const key of secrets) {
        if (isMasked(config[key])) config[key] = record.adapter.config[key]
      }
      record.adapter = { type: patch.adapter.type, config: this.validateAdapter(patch.adapter.type, config) }
    }
    await this.save()
    this.logger.info('updated bot %s', this.label(record))
    // Command settings are read on every message, so changing only them needs no restart.
    const restart = patch.name !== undefined || patch.adapter !== undefined || patch.provider !== undefined
    if (record.enabled && restart) await this.start(id).catch(() => {})
    return this.describe(record)
  }

  async remove(id: string) {
    const record = this.get(id)
    await this.stopRuntime(id)
    this.records = this.records.filter((item) => item !== record)
    this.buffers.delete(id)
    this.logs.delete(id)
    this.startErrors.delete(id)
    await this.save()
    this.logger.info('deleted bot %s', this.label(record))
    return { deleted: id }
  }

  // ---- runtimes ----

  private startSafely(id: string) {
    this.start(id).catch((error) => this.logger.warn('failed to start bot %s: %s', id, error))
  }

  async start(id: string) {
    const record = this.get(id)
    await this.stopRuntime(id)
    this.startErrors.delete(id)
    const adapter = this.adapterStore.get(record.adapter.type)
    if (!adapter) {
      const message = `Adapter "${record.adapter.type}" is not loaded; enable its plugin`
      this.startErrors.set(id, message)
      this.emitStatus(id)
      this.logger.warn('cannot start bot %s: %s', this.label(record), message)
      throw new MushinError('unavailable', message)
    }

    const runtime: Runtime = { plugins: new Map(), pluginErrors: new Map() }
    const loaded: { entry: BotPluginEntry; plugin: Plugin }[] = []
    for (const entry of record.plugins) {
      if (!entry.enabled) continue
      try {
        loaded.push({ entry, plugin: await this.loadBotPlugin(entry.package) })
      } catch (error) {
        runtime.pluginErrors.set(entry.package, error instanceof Error ? error.message : String(error))
      }
    }

    const hooks: BotHooks = {
      record: (partial) => this.record(partial),
      status: (bot) => {
        runtime.bot = bot
        // Connecting is left to the bot's own log, so a reconnect loop writes one error line here, not one per try.
        if (bot.status !== 'connecting' && bot.status !== runtime.logged && (runtime.logged || bot.status !== 'offline')) {
          runtime.logged = bot.status
          if (bot.status === 'error') this.logger.warn('bot %s: error (%s)', this.label(record), bot.error ?? 'no details')
          else this.logger.info('bot %s is %s', this.label(record), bot.status)
        }
        this.emitStatus(id)
      },
      commands: (bot) => this.commands(bot.id),
      commandCalled: (bot, entry, session) => {
        this.home.emit('bots/command', { botId: bot.id, name: entry.name, source: entry.source, userId: session.user.id, channel: session.channel, at: Date.now() })
      },
      builtinCommand: (bot, entry, session) => {
        if (entry.name !== HELP_COMMAND.name) return
        let entries = this.commands(bot.id)
        if (bot.record.commands?.helpByRole) {
          const role = session.role()
          entries = entries.filter((item) => {
            const required = requiredRole(item)
            return !required || roleAtLeast(role, required)
          })
        }
        return helpText(entries, bot.record.commands)
      },
      roleOf: (bot, userId) => this.permissionProvider?.roleOf(bot.id, userId),
      appCommand: (bot, entry) => this.appCommandFor(bot.id, entry)?.handler,
    }
    this.runtimes.set(id, runtime)
    runtime.fiber = this.home.isolate('bot').plugin({
      name: `bot:${record.name}`,
      apply: (ctx: Context) => {
        runtime.ctx = ctx
        this.runtimeFibers.set(ctx.fiber, id)
        ctx.effect(() => () => this.runtimeFibers.delete(ctx.fiber), 'bot log attribution')
        const enabled = loaded.map(({ entry }) => entry.package.replace(/^@mushin\/bot-plugin-/, ''))
        ctx.logger('bot').info('starting with the %s adapter; plugins: %s', record.adapter.type, enabled.join(', ') || 'none')
        for (const [name, error] of runtime.pluginErrors) ctx.logger('bot').warn('plugin %s did not load: %s', name, error)
        ctx.plugin(Bot, { record, hooks })
        ctx.plugin(adapter.plugin, record.adapter.config)
        for (const { entry, plugin } of loaded) runtime.plugins.set(entry.package, ctx.plugin(plugin, entry.config))
      },
    })
    await runtime.fiber
    runtime.bot = runtime.ctx?.get('bot') ?? runtime.bot
    const error = fiberError(runtime.fiber)
    if (error) this.logger.warn('bot %s failed to start: %s', this.label(record), error)
    else this.logger.info('started bot %s with the %s adapter', this.label(record), record.adapter.type)
    this.emitStatus(id)
    return this.status(id)
  }

  private async stopRuntime(id: string) {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    this.runtimes.delete(id)
    await runtime.fiber?.dispose()
    this.logger.info('stopped bot %s', this.label(this.records.find((item) => item.id === id) ?? id))
    this.emitStatus(id)
  }

  async setEnabled(id: string, enabled: boolean) {
    const record = this.get(id)
    record.enabled = enabled
    await this.save()
    if (enabled) return this.start(id)
    await this.stopRuntime(id)
    return this.status(id)
  }

  private label(record: BotRecord | string) {
    return typeof record === 'string' ? record : `"${record.name}" (${record.id})`
  }

  // ---- bot plugins ----

  async loadBotPlugin(name: string) {
    const entry = await this.home.manager.findPackage(name)
    if (!entry) throw new MushinError('not_found', `Bot plugin "${name}" is not installed`)
    if (entry.manifest.kind !== 'bot') throw new MushinError('invalid_input', `"${name}" is an app plugin, not a bot plugin`)
    return this.home.manager.loadPlugin(name)
  }

  async plugins(id: string) {
    const record = this.get(id)
    const runtime = this.runtimes.get(id)
    const graph = await this.home.manager.graph()
    const catalog = graph.catalog.filter((entry) => entry.manifest.kind === 'bot')
    return Promise.all(catalog.map(async (entry) => {
      const configured = record.plugins.find((item) => item.package === entry.package)
      let configSchema
      try {
        configSchema = pluginSchema(await this.home.manager.loadPlugin(entry.package))
      } catch {}
      const fiber = runtime?.plugins.get(entry.package)
      const report = dependencyReport(graph, entry.package)
      const missing = this.missingApps(report.requires)
      let status: string = configured?.enabled ? (runtime ? fiberStatus(fiber) : 'disabled') : 'disabled'
      if (status === 'pending' && missing.length) status = 'missing'
      return {
        package: entry.package,
        version: entry.version,
        manifest: entry.manifest,
        enabled: !!configured?.enabled,
        config: configured?.config ?? {},
        configSchema,
        status,
        error: runtime?.pluginErrors.get(entry.package) ?? (status === 'missing' ? describeMissing(missing) : fiberError(fiber)),
        dependencies: { requires: report.requires, optional: report.optional },
        ...(missing.length ? { missing } : {}),
      }
    }))
  }

  /** Required app plugins that are not installed, do not fit or are disabled. */
  private missingApps(requires: ReturnType<typeof dependencyReport>['requires']): MissingDependency[] {
    return requires
      .filter((dep) => dep.problem === 'not-installed' || dep.problem === 'version' || dep.problem === 'disabled')
      .map((dep) => ({ package: dep.package, range: dep.range, reason: dep.problem as MissingDependency['reason'], ...(dep.version ? { version: dep.version } : {}) }))
  }

  async enablePlugin(id: string, name: string, config?: Record<string, any>) {
    const record = this.get(id)
    const plugin = await this.loadBotPlugin(name)
    const missing = this.missingApps(dependencyReport(await this.home.manager.graph(), name).requires)
    if (missing.length) {
      throw new MushinError('unavailable', `${name} cannot run on this bot yet. ${describeMissing(missing)}; enable them on the plugins page`, { missing })
    }
    let entry = record.plugins.find((item) => item.package === name)
    const nextConfig = config ?? entry?.config ?? {}
    validatePluginConfig(plugin, nextConfig)
    if (!entry) {
      entry = { package: name, enabled: true, config: nextConfig }
      record.plugins.push(entry)
    }
    entry.enabled = true
    entry.config = nextConfig
    await this.save()
    this.logger.info('enabled plugin %s on bot %s', name, this.label(record))
    this.reloadPlugin(id, entry, plugin)
    return this.plugins(id).then((list) => list.find((item) => item.package === name))
  }

  async disablePlugin(id: string, name: string) {
    const record = this.get(id)
    const entry = record.plugins.find((item) => item.package === name)
    if (!entry) throw new MushinError('not_found', `${name} is not configured on this bot`)
    entry.enabled = false
    await this.save()
    this.logger.info('disabled plugin %s on bot %s', name, this.label(record))
    const runtime = this.runtimes.get(id)
    const fiber = runtime?.plugins.get(name)
    runtime?.plugins.delete(name)
    await fiber?.dispose()
    return this.plugins(id).then((list) => list.find((item) => item.package === name))
  }

  async configurePlugin(id: string, name: string, config: Record<string, any>) {
    const record = this.get(id)
    const entry = record.plugins.find((item) => item.package === name)
    if (!entry) return this.enablePlugin(id, name, config)
    const plugin = await this.loadBotPlugin(name)
    validatePluginConfig(plugin, config)
    entry.config = config
    await this.save()
    this.logger.info('config of plugin %s on bot %s changed', name, this.label(record))
    if (entry.enabled) this.reloadPlugin(id, entry, plugin)
    return this.plugins(id).then((list) => list.find((item) => item.package === name))
  }

  private reloadPlugin(id: string, entry: BotPluginEntry, plugin: Plugin) {
    const runtime = this.runtimes.get(id)
    if (!runtime?.ctx) return
    runtime.plugins.get(entry.package)?.dispose()
    runtime.pluginErrors.delete(entry.package)
    runtime.plugins.set(entry.package, runtime.ctx.plugin(plugin, entry.config))
  }

  // ---- commands ----

  /** Adds commands to every bot's list. Removed when the calling plugin unloads. */
  defineCommands(provider: CommandProvider) {
    return this.ctx.effect(() => {
      this.commandProviders.add(provider)
      return () => this.commandProviders.delete(provider)
    }, 'bots.defineCommands()')
  }

  /**
   * Answers a command on every bot (or those `bots` picks) from an app plugin, such as `/persona`.
   * It answers after flows, like `/help`, and shows in each bot's command list.
   */
  defineCommand(def: CommandDef, handler: AppCommand['handler'], options: { bots?: (botId: string) => boolean } = {}) {
    const ctx = this.ctx
    const command: AppCommand = { def, plugin: ctx.fiber.name, handler, bots: options.bots }
    return ctx.effect(() => {
      this.appCommands.add(command)
      return () => this.appCommands.delete(command)
    }, `bots.defineCommand(${def.name})`)
  }

  /** The app plugin command behind a command entry, if an app plugin answers it. */
  appCommandFor(botId: string, entry: CommandEntry) {
    if (entry.source.kind !== 'plugin') return
    return [...this.appCommands].find((item) => item.plugin === entry.source.id && commandMatches(item.def, entry.name) && (item.bots?.(botId) ?? true))
  }

  /** Lets the permissions plugin say who is master, admin or user on each bot. */
  usePermissions(provider: PermissionProvider) {
    return this.ctx.effect(() => {
      this.permissionProvider = provider
      return () => {
        if (this.permissionProvider === provider) this.permissionProvider = undefined
      }
    }, 'bots.usePermissions()')
  }

  /** A user's role on a bot; nothing when the permissions plugin is not running. */
  roleOf(botId: string, userId: string) {
    return this.permissionProvider?.roleOf(botId, userId)
  }

  /** Commands registered on one bot: from command providers such as flows, its plugins, and the built-in help. */
  commands(botId: string): CommandEntry[] {
    const record = this.records.find((item) => item.id === botId)
    if (!record) return []
    const entries: CommandEntry[] = []
    for (const provider of this.commandProviders) {
      try {
        entries.push(...provider(botId))
      } catch (error) {
        this.logger.warn('listing commands failed: %s', error)
      }
    }
    entries.push(...(this.runtimes.get(botId)?.bot?.localCommands() ?? []))
    for (const command of this.appCommands) {
      if (command.bots && !command.bots(botId)) continue
      entries.push({ ...command.def, botId, source: { kind: 'plugin', id: command.plugin, name: command.plugin } })
    }
    if (record.commands?.help !== false && !entries.some((entry) => commandMatches(entry, HELP_COMMAND.name))) {
      entries.push({ ...HELP_COMMAND, botId, source: { kind: 'builtin', id: 'help', name: 'help' } })
    }
    return entries
  }

  /** Commands of one bot or of every bot, with names that more than one source registers. */
  commandList(botId?: string) {
    if (botId) this.get(botId)
    const entries = (botId ? [botId] : this.records.map((record) => record.id)).flatMap((id) => this.commands(id))
    const conflicts = commandConflicts(entries).map((item) => ({ botId: item.botId, name: item.name, sources: item.entries.map((entry) => entry.source) }))
    return { commands: entries, conflicts }
  }

  /**
   * Runs a command as if a master sent it. With a target it really runs on the bot: in that group,
   * or in the master's private chat, and the replies are sent. Without one it only previews where
   * the message would go (through flows), so nothing is sent.
   */
  async runCommand(input: RunCommandInput, source?: Provenance) {
    const record = this.get(input.bot)
    const prefix = record.commands?.prefixes?.find(Boolean) ?? '/'
    const text = /^\p{L}/u.test(input.command) && !input.command.startsWith(prefix) ? `${prefix}${input.command}` : input.command
    if (!input.target) {
      const flows = this.home.get('flows') as { route(botId: string, input: { text: string; role?: string }): Promise<unknown> } | undefined
      if (!flows) throw new MushinError('unavailable', 'Previewing a command needs the flows plugin; give a target to run it for real')
      return { simulated: true, text, route: await flows.route(record.id, { text, role: 'master' }) }
    }
    const bot = this.bot(record.id)
    if (!bot || this.status(record.id).status !== 'online') throw new MushinError('unavailable', `Bot "${record.name}" is not online`)
    const permissions = this.home.get('permissions') as { get(botId: string): { masters: string[] } } | undefined
    const userId = input.user ?? permissions?.get(record.id).masters[0]
    if (!userId) throw new MushinError('invalid_input', `Bot "${record.name}" has no master; add one with permissions.update or pass user`)
    if (input.target === 'group' && !input.group) throw new MushinError('invalid_input', 'Pass the group id to run a command in a group')
    const channel: ChannelInfo = input.target === 'group' ? { type: 'group', id: input.group! } : { type: 'private', id: userId }
    const replies: MessageRecord[] = []
    const collect = (message: MessageRecord) => {
      if (message.botId === record.id && message.direction === 'out' && message.channel.id === channel.id) replies.push(message)
    }
    const stop = this.home.on('bots/message', collect)
    try {
      await bot.receive({ channel, user: { id: userId }, segments: [{ type: 'text', data: { text } }] }, { source })
    } finally {
      stop()
    }
    return {
      simulated: false,
      text,
      channel,
      user: userId,
      replies: replies.map((reply) => segmentsToText(reply.segments)),
    }
  }

  // ---- logs ----

  /** Finds the bot whose context wrote a log message, by walking up from the writing fiber. */
  private botOf(message: Message) {
    let fiber = message.fiber?.deref()
    while (fiber) {
      const id = this.runtimeFibers.get(fiber)
      if (id) return id
      const parent = fiber.parent?.fiber
      if (!parent || parent === fiber) return
      fiber = parent
    }
  }

  /** True when a log line was written inside a bot; it belongs in that bot's log, not the global one. */
  isBotLog(message: Message) {
    return this.botLogSns.has(message.sn) || !!this.botOf(message)
  }

  private captureLog(message: Message) {
    const botId = this.botOf(message)
    if (!botId) return
    this.botLogSns.add(message.sn)
    // The global log buffer holds 1000 lines; remember a little more than that.
    if (this.botLogSns.size > 2000) this.botLogSns.delete(this.botLogSns.values().next().value!)
    const line: BotLogLine = {
      botId,
      sn: message.sn,
      ts: message.ts,
      type: message.type,
      name: message.name,
      tag: logTag(message.name),
      text: Logger.format(plainExporter, message),
    }
    let buffer = this.logs.get(botId)
    if (!buffer) this.logs.set(botId, buffer = [])
    buffer.push(line)
    if (buffer.length > LOG_BUFFER_SIZE) buffer.splice(0, buffer.length - LOG_BUFFER_SIZE)
    this.home.emit('bots/log', line)
    const day = new Date(line.ts).toISOString().slice(0, 10)
    this.home.storage.append(`logs/${botId}/${day}`, line).catch(() => {})
  }

  async logLines(id: string, limit = 200) {
    this.get(id)
    let buffer = this.logs.get(id)
    if (!buffer) {
      const day = new Date().toISOString().slice(0, 10)
      // Lines stored before tags existed get one from their logger name.
      buffer = (await this.home.storage.tail<BotLogLine>(`logs/${id}/${day}`, LOG_BUFFER_SIZE))
        .map((line) => (line.tag ? line : { ...line, tag: logTag(line.name) }))
      this.logs.set(id, buffer)
    }
    return buffer.slice(-limit)
  }

  // ---- messages ----

  private record(partial: Omit<MessageRecord, 'id' | 'type' | 'platforms'>): MessageRecord {
    const record: MessageRecord = {
      ...partial,
      id: randomId(8),
      type: messageType(partial.segments),
      platforms: this.platformsFor(partial.segments),
    }
    let buffer = this.buffers.get(record.botId)
    if (!buffer) this.buffers.set(record.botId, buffer = [])
    buffer.push(record)
    if (buffer.length > BUFFER_SIZE) buffer.splice(0, buffer.length - BUFFER_SIZE)
    const day = new Date(record.timestamp).toISOString().slice(0, 10)
    this.home.storage.append(`messages/${record.botId}/${day}`, record).catch((error) => {
      this.logger.warn('failed to write message log: %s', error)
    })
    this.archive?.add(record)
    this.home.emit('bots/message', record)
    return record
  }

  /**
   * Recent messages of a bot, oldest first. With the database plugin, a channel's history and
   * older pages (`before`) come from the database; otherwise from today's log and memory.
   */
  async messages(id: string, options: { limit?: number; channel?: string; before?: number } = {}) {
    this.get(id)
    const limit = options.limit ?? 100
    const archive = this.archive?.ready ? this.archive : undefined
    if (archive && (options.channel || options.before)) return archive.query(id, { ...options, limit })
    let buffer = this.buffers.get(id)
    if (!buffer) {
      const day = new Date().toISOString().slice(0, 10)
      buffer = archive
        ? await archive.query(id, { limit: BUFFER_SIZE })
        : await this.home.storage.tail<MessageRecord>(`messages/${id}/${day}`, BUFFER_SIZE)
      // Messages recorded while loading are already in the buffer that `record` made.
      const current = this.buffers.get(id)
      if (current) buffer = [...buffer.filter((item) => !current.some((record) => record.id === item.id)), ...current].slice(-BUFFER_SIZE)
      this.buffers.set(id, buffer)
    }
    if (options.before) buffer = buffer.filter((record) => record.timestamp < options.before!)
    const list = options.channel ? buffer.filter((record) => record.channel.id === options.channel) : buffer
    return list.slice(-limit)
  }

  /** Channels seen recently, newest first, for the live view's channel list. */
  async channels(id: string) {
    const seen = new Map<string, ChannelInfo & { lastAt: number; lastText: string }>()
    for (const record of await this.messages(id, { limit: BUFFER_SIZE })) {
      const key = `${record.channel.type}:${record.channel.id}`
      const text = record.segments.map((s) => (s.type === 'text' ? s.data.text : `[${s.type}]`)).join('')
      seen.set(key, { ...record.channel, name: record.channel.name ?? seen.get(key)?.name, lastAt: record.timestamp, lastText: text.slice(0, 80) })
    }
    return [...seen.values()].sort((a, b) => b.lastAt - a.lastAt)
  }

  async sendManual(id: string, channel: ChannelInfo, text: string) {
    const bot = this.bot(id)
    if (!bot) throw new MushinError('unavailable', 'The bot is not running')
    return bot.deliver(channel, text, { source: { kind: 'manual' } })
  }

  // ---- actions ----

  private *defineActions() {
    const actions = this.home.actions

    yield actions.define({
      name: 'bots.adapters',
      description: 'List loaded adapter types (e.g. "onebot") with their config JSON Schemas.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.adapters(),
    })

    yield actions.define({
      name: 'bots.list',
      description: 'List bots with their connection status, adapter and enabled plugins. Secrets are masked.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.list(),
    })

    yield actions.define({
      name: 'bots.get',
      description: 'Get one bot with its status.',
      risk: 'read',
      input: idInput,
      handler: ({ id }) => this.describe(this.get(id)),
    })

    yield actions.define({
      name: 'bots.create',
      description: 'Create a bot and start it. For NapCat use adapter type "onebot" with mode "forward" (url of NapCat\'s WebSocket server, e.g. ws://127.0.0.1:3001) or mode "reverse" (NapCat connects to Mushin). Returns the bot with its id.',
      risk: 'write',
      input: z.object({
        name: z.string().min(1),
        adapter: adapterInput,
        plugins: z.array(z.object({ package: z.string(), config: z.record(z.string(), z.any()).optional() })).optional()
          .describe('Bot plugins to enable right away, e.g. @mushin/bot-plugin-llm-chat'),
        enabled: z.boolean().optional(),
        provider: z.string().optional().describe('Default provider id for this bot\'s LLM plugins'),
        commands: commandSettingsInput.optional(),
      }),
      handler: (input) => this.create(input),
    })

    yield actions.define({
      name: 'bots.update',
      description: 'Rename a bot, change its adapter connection, default provider or command settings. Restarts the bot if it is enabled, unless only command settings change.',
      risk: 'write',
      input: idInput.extend({
        name: z.string().min(1).optional(),
        adapter: adapterInput.optional(),
        provider: z.string().nullable().optional(),
        commands: commandSettingsInput.optional().describe('Command prefixes and the built-in /help; changing only these does not restart the bot'),
      }),
      handler: ({ id, ...patch }) => this.update(id, patch),
    })

    yield actions.define({
      name: 'commands.list',
      description: 'List the commands (such as /help, /checkin) each bot answers, with where each comes from: a flow\'s command node, a bot plugin or the built-in help. Also lists names that two sources register on the same bot.',
      risk: 'read',
      input: z.object({ bot: z.string().optional().describe('Bot id from bots.list; all bots when omitted') }),
      handler: ({ bot }) => this.commandList(bot),
    })

    yield actions.define({
      name: 'bots.commands.run',
      description: 'Run a bot command such as /checkin as the bot\'s master. With target "group" (and the group id) or "master" (the master\'s private chat) it runs for real and the bot sends its replies there; without a target it only previews which flow or plugin would answer, and sends nothing.',
      risk: 'write',
      input: z.object({
        bot: z.string().describe('Bot id from bots.list'),
        command: z.string().min(1).describe('The command with its arguments, e.g. "/checkin" or "/score 85"'),
        target: z.enum(['master', 'group']).optional().describe('Where to run it for real; omit to only preview'),
        group: z.string().optional().describe('Group id, with target "group"'),
        user: z.string().optional().describe('Run as this user id instead of the first master'),
      }),
      handler: (input, caller) => this.runCommand(input, caller.kind === 'agent' && caller.session ? { kind: 'agent', session: caller.session } : undefined),
    })

    yield actions.define({
      name: 'bots.delete',
      description: 'Delete a bot and its settings. Message logs on disk are kept.',
      risk: 'dangerous',
      input: idInput,
      handler: ({ id }) => this.remove(id),
    })

    yield actions.define({
      name: 'bots.start',
      description: 'Enable and start (or restart) a bot.',
      risk: 'write',
      input: idInput,
      handler: ({ id }) => this.setEnabled(id, true),
    })

    yield actions.define({
      name: 'bots.stop',
      description: 'Stop and disable a bot.',
      risk: 'write',
      input: idInput,
      handler: ({ id }) => this.setEnabled(id, false),
    })

    yield actions.define({
      name: 'bots.plugins.list',
      description: 'List every installed bot plugin with whether it is enabled on this bot, its config and status.',
      risk: 'read',
      input: idInput,
      handler: ({ id }) => this.plugins(id),
    })

    yield actions.define({
      name: 'bots.plugins.enable',
      description: 'Enable a bot plugin on one bot, optionally with config.',
      risk: 'write',
      input: pluginInput.extend({ config: z.record(z.string(), z.any()).optional() }),
      handler: ({ id, package: name, config }) => this.enablePlugin(id, name, config),
    })

    yield actions.define({
      name: 'bots.plugins.disable',
      description: 'Disable a bot plugin on one bot. Its config is kept.',
      risk: 'write',
      input: pluginInput,
      handler: ({ id, package: name }) => this.disablePlugin(id, name),
    })

    yield actions.define({
      name: 'bots.plugins.configure',
      description: 'Replace a bot plugin\'s config on one bot and reload it.',
      risk: 'write',
      input: pluginInput.extend({ config: z.record(z.string(), z.any()) }),
      handler: ({ id, package: name, config }) => this.configurePlugin(id, name, config),
    })

    yield actions.define({
      name: 'bots.messages',
      description: 'Recent messages of a bot, oldest first, with type, supported platforms and source. Without a channel or `before`, the last 500 the bot saw.',
      risk: 'read',
      input: idInput.extend({
        limit: z.number().int().min(1).max(BUFFER_SIZE).optional(),
        channel: z.string().optional().describe('Group or user id to filter by'),
        before: z.number().optional().describe('Only messages sent before this time (ms since 1970), to page back through older messages; with the database plugin the history goes back to the first message'),
      }),
      handler: ({ id, ...options }) => this.messages(id, options),
    })

    yield actions.define({
      name: 'bots.logs',
      description: 'Recent log lines of one bot, oldest first: connection events, adapter errors, plugin warnings, and why LLM chat skipped messages. Read this first when a bot misbehaves.',
      risk: 'read',
      input: idInput.extend({ limit: z.number().int().min(1).max(LOG_BUFFER_SIZE).optional() }),
      handler: ({ id, limit }) => this.logLines(id, limit),
    })

    yield actions.define({
      name: 'bots.channels',
      description: 'Channels (groups and private chats) a bot has seen recently.',
      risk: 'read',
      input: idInput,
      handler: ({ id }) => this.channels(id),
    })

    yield actions.define({
      name: 'bots.send',
      description: 'Send a text message from a bot to a group or private chat.',
      risk: 'write',
      input: idInput.extend({
        channel: z.object({ type: z.enum(['group', 'private']), id: z.string() }),
        text: z.string().min(1),
      }),
      handler: ({ id, channel, text }) => this.sendManual(id, channel, text),
    })
  }
}
