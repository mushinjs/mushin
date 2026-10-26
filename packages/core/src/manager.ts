import { pathToFileURL } from 'node:url'
import { Context, type Fiber, type Plugin, Service } from 'cordis'
import { z } from 'zod'
import { toJsonSchema, type JsonSchema } from './actions'
import {
  type DependencyGraph, dependencyReport, type DependencyState, loadOrder, planDisable, planEnable, providerOf, undeclaredServices, unmet,
  injectedServices,
} from './dependencies'
import { MushinError } from './errors'
import { type CatalogEntry, manifestProblems, MUSHIN_VERSION, type PluginManifest, readPackageJson, resolvePackageEntry, scanCatalog } from './manifest'
import { writeJsonAtomic } from './utils'

declare module 'cordis' {
  interface Context {
    manager: PluginManager
  }

  interface Events {
    'manager/changed'(id: string): void
  }
}

export interface PluginEntry {
  id: string
  package: string
  enabled?: boolean
  config?: Record<string, any>
}

export interface InstanceConfig {
  plugins: PluginEntry[]
}

export interface ManagerOptions {
  configPath: string
  config: InstanceConfig
  /** `node_modules` directories searched for plugin packages. */
  nodeModules: string[]
  /** Directories holding local plugin folders. */
  localDirs: string[]
  /** Imports a module by specifier; supplied by the launcher so bare names resolve from its location. */
  importer: (specifier: string) => Promise<any>
}

/** `missing`: waiting for a dependency that is not installed, not enabled or not running. */
export type PluginStatus = 'disabled' | 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | 'missing'

/** A required dependency that keeps a plugin from running, or a service nothing provides yet. */
export interface MissingDependency {
  package?: string
  service?: string
  range?: string
  /** `inactive`: enabled, but not running yet (or failed). */
  reason: 'not-installed' | 'version' | 'disabled' | 'inactive' | 'mushin' | 'cycle'
  version?: string
}

// Mirrors cordis FiberState, a const enum that cannot be imported under isolatedModules.
const fiberStates: PluginStatus[] = ['pending', 'loading', 'active', 'failed', 'disabled', 'unloading']

export function fiberStatus(fiber: Fiber | undefined): PluginStatus {
  if (!fiber) return 'disabled'
  return fiberStates[fiber.state] ?? 'pending'
}

export function fiberError(fiber: Fiber | undefined): string | undefined {
  // Cordis keeps the failure on a private field; it is the only way to show why a plugin failed.
  const error = (fiber as any)?._error
  if (!error) return
  return error instanceof Error ? error.message : String(error)
}

/** Picks the plugin out of a module: a default export, or the module namespace itself. */
export function unwrapPlugin(mod: any): Plugin {
  const value = mod?.default
  if (value && (typeof value === 'function' || typeof value.apply === 'function')) return value
  if (typeof mod?.apply === 'function') return mod
  throw new Error('module does not export a Cordis plugin')
}

/** JSON Schema of a plugin's zod `Config`, if it has one. */
export function pluginSchema(plugin: Plugin): JsonSchema | undefined {
  const config = (plugin as any).Config
  if (config && typeof config === 'object' && '_zod' in config) return toJsonSchema(config)
}

export function validatePluginConfig(plugin: Plugin, config: unknown) {
  const schema = (plugin as any).Config
  if (!schema || typeof schema !== 'object' || !('_zod' in schema)) return config
  const result = (schema as z.ZodType).safeParse(config ?? {})
  if (!result.success) throw new MushinError('invalid_input', z.prettifyError(result.error), result.error.issues)
  return config
}

const entryInput = z.object({ id: z.string().describe('Plugin entry id from plugins.list') })

/** Manifests for Cordis plugins that Mushin.js uses but that do not ship a `mushin` field. */
const knownManifests: Record<string, PluginManifest> = {
  '@cordisjs/plugin-server': {
    kind: 'app',
    essential: true,
    provides: ['server'],
    displayName: { en: 'HTTP server', 'zh-CN': 'HTTP 服务器' },
    description: { en: 'Serves the dashboard, the API and OneBot reverse connections', 'zh-CN': '提供控制台、API 和 OneBot 反向连接' },
  },
}

export function knownManifest(name: string) {
  return knownManifests[name]
}

/**
 * Loads app plugins listed in mushin.config.json and keeps the file in sync
 * when plugins are enabled, disabled or reconfigured at runtime.
 */
export class PluginManager extends Service {
  static inject = ['actions']

  /** The manager's own context; plugins load here, never under a caller's context. */
  private home: Context
  private fibers = new Map<string, Fiber>()
  private catalogCache?: Promise<CatalogEntry[]>
  /** The last catalog read, for status checks that cannot wait. */
  private catalogList: CatalogEntry[] = []
  /** Entries that were not started because a dependency is missing or they form a cycle. */
  private blocked = new Map<string, MissingDependency[]>()

  constructor(ctx: Context, public options: ManagerOptions) {
    super(ctx, 'manager')
    this.home = ctx
  }

  /** Plugin lifecycle lines, tagged `plugin` in the dashboard. */
  private get logger() {
    return this.home.logger('plugin')
  }

  get entries() {
    return this.options.config.plugins
  }

  async *[Service.init]() {
    yield this.home.on('internal/status', (fiber) => {
      for (const [id, tracked] of this.fibers) {
        if (tracked.ctx.fiber !== fiber) continue
        const status = fiberStatus(fiber)
        if (status === 'active') this.logger.info('%s is active', id)
        else if (status === 'failed') this.logger.error('%s failed: %s', id, fiberError(fiber) ?? 'no details')
        this.home.emit('manager/changed', id)
      }
    })
    yield* this.defineActions()
    const graph = await this.graph()
    for (const entry of this.catalogList) {
      for (const problem of manifestProblems(entry.manifest)) this.logger.warn('%s: %s in its package.json "mushin" field', entry.package, problem)
    }
    // Dependencies first, so a plugin finds what it needs already loading.
    const { order, cycles } = loadOrder(graph, this.entries.filter((entry) => entry.enabled !== false))
    for (const cycle of cycles) {
      this.logger.error('dependency cycle: %s; these plugins do not start', cycle.chain.join(' → '))
      for (const entry of cycle.entries) this.blocked.set(entry.id, [{ reason: 'cycle', package: cycle.chain.join(' → ') }])
    }
    for (const entry of order) {
      await this.start(entry).catch((error) => {
        this.logger.error('failed to load %s: %s', entry.package, error)
      })
    }
  }

  catalog(refresh = false) {
    if (refresh || !this.catalogCache) {
      this.catalogCache = scanCatalog(this.options.nodeModules, this.options.localDirs)
      this.catalogCache.then((list) => (this.catalogList = list), () => {})
    }
    return this.catalogCache
  }

  /** The installed packages as last scanned, without waiting for a rescan. */
  get catalogSnapshot(): readonly CatalogEntry[] {
    return this.catalogList
  }

  /** The package whose manifest says it adds this flow node type, e.g. `onebot.*` covers `onebot.kick`. */
  packageForNode(type: string) {
    return this.catalogList.find((entry) => entry.manifest.nodes?.some((pattern) => (pattern.endsWith('*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type)))
  }

  /** The catalog and entries, for dependency questions. */
  async graph(refresh = false): Promise<DependencyGraph> {
    this.catalogList = await this.catalog(refresh)
    return this.graphNow()
  }

  private graphNow(): DependencyGraph {
    return { catalog: this.catalogList, entries: this.entries, known: knownManifest }
  }

  /** Dependencies, dependents and what enabling or disabling the package would take. */
  async dependencies(name: string) {
    const graph = await this.graph()
    const entry = this.entries.find((item) => item.package === name)
    return {
      ...dependencyReport(graph, name),
      enable: planEnable(graph, name),
      disable: planDisable(graph, name),
      ...(entry ? { missing: this.missingOf(entry) } : {}),
    }
  }
  async findPackage(name: string) {
    return (await this.catalog()).find((entry) => entry.package === name)
  }

  /** Imports a plugin package. Catalogued packages load from their own directory. */
  async loadPlugin(name: string): Promise<Plugin> {
    const entry = await this.findPackage(name)
    if (!entry) return unwrapPlugin(await this.options.importer(name))
    const pkg = await readPackageJson(entry.path)
    const file = resolvePackageEntry(entry.path, pkg ?? {})
    return unwrapPlugin(await this.options.importer(pathToFileURL(file).href))
  }

  get(id: string) {
    return this.entries.find((entry) => entry.id === id)
  }

  status(id: string): { status: PluginStatus; error?: string; missing?: MissingDependency[] } {
    const blocked = this.blocked.get(id)
    if (blocked) return { status: 'missing', error: describeMissing(blocked), missing: blocked }
    const fiber = this.fibers.get(id)
    const status = fiberStatus(fiber)
    const entry = this.get(id)
    if (status === 'pending' && entry) {
      const missing = this.missingOf(entry)
      if (missing.length) return { status: 'missing', error: describeMissing(missing), missing }
    }
    return { status, error: fiberError(fiber) }
  }

  /** What keeps an enabled entry from running: required plugins that are absent or stopped, and injected services nobody provides. */
  private missingOf(entry: PluginEntry): MissingDependency[] {
    const graph = this.graphNow()
    const missing: MissingDependency[] = []
    for (const dep of dependencyReport(graph, entry.package).requires) {
      if (dep.kind === 'bot') continue
      const reason = this.depReason(dep)
      if (reason) missing.push({ package: dep.package, range: dep.range, reason, ...(dep.version ? { version: dep.version } : {}) })
    }
    const fiber = this.fibers.get(entry.id)
    for (const service of injectedServices({ inject: fiber?.inject }).required) {
      if (this.home.get(service as any) !== undefined) continue
      const provider = providerOf(graph, service)
      if (provider && missing.some((item) => item.package === provider)) continue
      const providerEntry = provider ? this.entries.find((item) => item.package === provider) : undefined
      missing.push({
        service,
        ...(provider ? { package: provider } : {}),
        reason: !provider ? 'not-installed' : !providerEntry || providerEntry.enabled === false ? 'disabled' : 'inactive',
      })
    }
    return missing
  }

  private depReason(dep: DependencyState): MissingDependency['reason'] | undefined {
    if (dep.problem === 'not-installed' || dep.problem === 'version' || dep.problem === 'disabled') return dep.problem
    if (dep.entry && fiberStatus(this.fibers.get(dep.entry)) !== 'active' && !knownManifest(dep.package)) return 'inactive'
  }

  /** Requirements checked before starting: the Mushin.js version and required plugins that are installed, fit and enabled. */
  private async preflight(entry: PluginEntry): Promise<MissingDependency[]> {
    const graph = await this.graph()
    const report = dependencyReport(graph, entry.package)
    const missing: MissingDependency[] = []
    if (report.mushin && !report.mushin.ok) missing.push({ reason: 'mushin', range: report.mushin.range, version: MUSHIN_VERSION })
    for (const dep of report.requires) {
      if (dep.kind === 'bot') continue
      if (dep.problem === 'not-installed' || dep.problem === 'version' || dep.problem === 'disabled') {
        missing.push({ package: dep.package, range: dep.range, reason: dep.problem, ...(dep.version ? { version: dep.version } : {}) })
      }
    }
    return missing
  }

  private async start(entry: PluginEntry) {
    this.logger.debug('starting %s (%s)', entry.id, entry.package)
    const missing = await this.preflight(entry)
    if (missing.length) {
      await this.fibers.get(entry.id)?.dispose()
      this.fibers.delete(entry.id)
      this.blocked.set(entry.id, missing)
      this.logger.warn('%s does not start: %s', entry.id, describeMissing(missing))
      this.home.emit('manager/changed', entry.id)
      return
    }
    this.blocked.delete(entry.id)
    const plugin = await this.loadPlugin(entry.package)
    for (const { service, provider } of undeclaredServices(this.graphNow(), entry.package, plugin)) {
      const local = this.catalogList.find((item) => item.package === entry.package)?.local
      // Mostly useful to plugin authors, whose plugins are usually local while they work on them.
      this.logger[local ? 'warn' : 'debug']('%s injects "%s" but does not declare %s in its manifest\'s requires or optional', entry.package, service, provider)
    }
    // Let the old instance release its resources (e.g. the server's port) before the new one starts.
    await this.fibers.get(entry.id)?.dispose()
    const fiber = this.home.plugin(plugin, entry.config ?? {})
    this.fibers.set(entry.id, fiber)
    this.home.emit('manager/changed', entry.id)
    return fiber
  }

  private async stop(id: string) {
    const fiber = this.fibers.get(id)
    if (this.blocked.delete(id)) this.home.emit('manager/changed', id)
    if (!fiber) return
    this.fibers.delete(id)
    await fiber.dispose()
    this.logger.info('%s stopped', id)
    this.home.emit('manager/changed', id)
  }

  save() {
    return writeJsonAtomic(this.options.configPath, this.options.config)
  }

  /**
   * Enables a plugin. Required plugins that are installed but disabled are refused unless
   * `cascade` is set, in which case they are enabled first; missing or mismatched ones always are.
   */
  async enable(name: string, id?: string, options: { cascade?: boolean } = {}) {
    const plan = planEnable(await this.graph(), name)
    if (plan.mushin.length) {
      const item = plan.mushin[0]
      throw new MushinError('unavailable', `${item.package} needs Mushin.js ${item.range}; this is ${item.version}`, { plan })
    }
    if (plan.blocked.length) {
      const list = plan.blocked.map((dep) => (dep.problem === 'version' ? `${dep.package}@${dep.range} (installed: ${dep.version})` : `${dep.package} (not installed)`))
      throw new MushinError('unavailable', `${name} needs ${list.join(', ')}`, { plan })
    }
    if (plan.enable.length && !options.cascade) {
      throw new MushinError('conflict', `${name} needs ${plan.enable.join(', ')}, which ${plan.enable.length > 1 ? 'are' : 'is'} disabled; enable ${plan.enable.length > 1 ? 'them' : 'it'} too with cascade: true`, { plan })
    }
    for (const dep of plan.enable) await this.enableOne(dep)
    const entry = await this.enableOne(name, id)
    await this.retryBlocked()
    return entry
  }

  private async enableOne(name: string, id?: string) {
    let entry = id ? this.get(id) : this.entries.find((item) => item.package === name)
    if (!entry) {
      const base = id ?? name.replace(/^@[^/]+\//, '').replace(/^(mushin-)?plugin-/, '')
      let unique = base
      for (let i = 2; this.get(unique); i++) unique = `${base}-${i}`
      entry = { id: unique, package: name, enabled: true, config: {} }
      this.entries.push(entry)
    }
    entry.enabled = true
    await this.save()
    this.logger.info('enabled %s (%s)', entry.id, entry.package)
    await this.start(entry)
    return entry
  }

  /**
   * Disables a plugin. Enabled plugins that require it are refused unless `cascade` is set, in
   * which case they are disabled first.
   */
  async disable(id: string, options: { cascade?: boolean } = {}) {
    const entry = this.require(id)
    await this.assertNotEssential(entry)
    // Another enabled entry of the same package keeps its dependents running.
    const twin = this.entries.some((item) => item !== entry && item.package === entry.package && item.enabled !== false)
    const plan = twin ? { disable: [], botPlugins: [], degraded: [] } : planDisable(await this.graph(), entry.package)
    if (plan.disable.length && !options.cascade) {
      throw new MushinError('conflict', `${plan.disable.map((item) => item.package).join(', ')} need${plan.disable.length > 1 ? '' : 's'} ${entry.package}; disable ${plan.disable.length > 1 ? 'them' : 'it'} too with cascade: true`, { plan })
    }
    for (const item of plan.disable) await this.assertNotEssential(this.require(item.id))
    for (const item of plan.disable) await this.disableOne(this.require(item.id))
    return this.disableOne(entry)
  }

  private async assertNotEssential(entry: PluginEntry) {
    const manifest = (await this.findPackage(entry.package))?.manifest ?? knownManifests[entry.package]
    if (manifest?.essential) {
      throw new MushinError('forbidden', `${entry.package} is essential and cannot be disabled`)
    }
  }

  private async disableOne(entry: PluginEntry) {
    const id = entry.id
    entry.enabled = false
    await this.save()
    this.logger.info('disabled %s', id)
    await this.stop(id)
    return entry
  }

  /** Starts entries that were held back for a missing dependency, once it is there. */
  private async retryBlocked() {
    for (const id of [...this.blocked.keys()]) {
      const entry = this.get(id)
      if (!entry || entry.enabled === false || this.blocked.get(id)?.some((item) => item.reason === 'cycle')) continue
      if ((await this.preflight(entry)).length) continue
      await this.start(entry).catch((error) => this.logger.error('failed to load %s: %s', entry.package, error))
    }
  }

  async configure(id: string, config: Record<string, any>) {
    const entry = this.require(id)
    const plugin = await this.loadPlugin(entry.package)
    validatePluginConfig(plugin, config)
    entry.config = config
    await this.save()
    this.logger.info('config of %s changed', id)
    if (entry.enabled !== false) await this.start(entry)
    return entry
  }

  async reload(id: string) {
    const entry = this.require(id)
    if (entry.enabled === false) throw new MushinError('conflict', `${id} is disabled`)
    this.logger.info('reloading %s', id)
    await this.stop(id)
    await this.start(entry)
    return entry
  }

  private require(id: string) {
    const entry = this.get(id)
    if (!entry) throw new MushinError('not_found', `No app plugin entry with id "${id}"`)
    return entry
  }

  async describe(entry: PluginEntry) {
    const catalog = await this.findPackage(entry.package)
    let configSchema: JsonSchema | undefined
    try {
      configSchema = pluginSchema(await this.loadPlugin(entry.package))
    } catch {}
    const report = dependencyReport(this.graphNow(), entry.package)
    return {
      id: entry.id,
      package: entry.package,
      enabled: entry.enabled !== false,
      config: entry.config ?? {},
      configSchema,
      manifest: catalog?.manifest ?? knownManifests[entry.package],
      version: catalog?.version,
      dependencies: { requires: report.requires, optional: report.optional, dependents: report.dependents, ...(report.mushin ? { mushin: report.mushin } : {}) },
      ...this.status(entry.id),
    }
  }

  private *defineActions() {
    const actions = this.home.actions

    yield actions.define({
      name: 'plugins.catalog',
      description: 'List installed plugin packages, both app plugins and bot plugins. Optionally filter by kind or a search query.',
      risk: 'read',
      input: z.object({
        kind: z.enum(['app', 'bot']).optional(),
        query: z.string().optional().describe('Case-insensitive text matched against names and descriptions'),
        refresh: z.boolean().optional().describe('Rescan the disk for newly added packages'),
      }),
      handler: async ({ kind, query, refresh }) => {
        let list = await this.catalog(refresh)
        if (kind) list = list.filter((entry) => entry.manifest.kind === kind)
        if (query) {
          const needle = query.toLowerCase()
          list = list.filter((entry) => JSON.stringify([entry.package, entry.manifest]).toLowerCase().includes(needle))
        }
        return list.map(({ path, ...rest }) => rest)
      },
    })

    yield actions.define({
      name: 'plugins.list',
      description: 'List app plugin entries with their status (active, pending, failed, disabled) and config.',
      risk: 'read',
      input: z.object({}),
      handler: () => Promise.all(this.entries.map((entry) => this.describe(entry))),
    })

    yield actions.define({
      name: 'plugins.dependencies',
      description: 'What a plugin package needs and what needs it: required and optional plugins with whether each is installed, fits the version range and is enabled; the plugins that depend on it; the app plugins enabling it would also enable; and the ones disabling it would also disable. Read this before enabling or disabling a plugin.',
      risk: 'read',
      input: z.object({ package: z.string().describe('Package name, e.g. @mushin/plugin-flows') }),
      handler: ({ package: name }) => this.dependencies(name),
    })

    yield actions.define({
      name: 'plugins.enable',
      description: 'Enable an app plugin by package name. Adds it to the config if it is not there yet. If it requires plugins that are disabled, this fails and names them unless cascade is true, which enables them first; tell the user which ones before doing that.',
      risk: 'write',
      input: z.object({ package: z.string(), id: z.string().optional(), cascade: z.boolean().optional().describe('Also enable the disabled plugins it requires') }),
      handler: async (input) => this.describe(await this.enable(input.package, input.id, { cascade: input.cascade })),
    })

    yield actions.define({
      name: 'plugins.disable',
      description: 'Disable an app plugin entry. Essential plugins cannot be disabled. If enabled plugins require it, this fails and names them unless cascade is true, which disables them too; tell the user which ones before doing that.',
      risk: 'write',
      input: entryInput.extend({ cascade: z.boolean().optional().describe('Also disable the plugins that require it') }),
      handler: async ({ id, cascade }) => this.describe(await this.disable(id, { cascade })),
    })

    yield actions.define({
      name: 'plugins.configure',
      description: 'Replace the config of an app plugin entry and restart it.',
      risk: 'write',
      input: entryInput.extend({ config: z.record(z.string(), z.any()) }),
      handler: async ({ id, config }) => this.describe(await this.configure(id, config)),
    })

    yield actions.define({
      name: 'plugins.reload',
      description: 'Restart an app plugin entry.',
      risk: 'write',
      input: entryInput,
      handler: async ({ id }) => this.describe(await this.reload(id)),
    })
  }
}

/** One line naming what keeps a plugin from running, for logs and status tooltips. */
export function describeMissing(missing: MissingDependency[]) {
  return 'Missing dependencies: ' + missing.map((item) => {
    const name = item.package ?? `service "${item.service}"`
    switch (item.reason) {
      case 'not-installed': return item.package ? `${name} (not installed)` : `${name} (no installed plugin provides it)`
      case 'version': return `${name}@${item.range} (installed: ${item.version})`
      case 'disabled': return `${name} (disabled)`
      case 'inactive': return `${name} (not running)`
      case 'mushin': return `Mushin.js ${item.range} (this is ${item.version})`
      case 'cycle': return `a dependency cycle: ${item.package}`
    }
  }).join(', ')
}
