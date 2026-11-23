import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, type Fiber, type Plugin, Service } from 'cordis'
import { z } from 'zod'
import { toJsonSchema, type JsonSchema } from './actions'
import {
  type DependencyGraph, dependencyReport, type DependencyState, loadOrder, planDisable, planEnable, providerOf, undeclaredServices, unmet,
  injectedServices,
} from './dependencies'
import { MushinError } from './errors'
import { EnvFile, envReference, resolveEnvReferences } from './env'
import { type CatalogEntry, manifestProblems, MUSHIN_VERSION, type PluginManifest, readPackageJson, resolvePackageEntry, scanCatalog } from './manifest'
import { isMasked, mask, writeJsonAtomic } from './utils'

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
  /**
   * Folders besides the app's plugins/ that hold local plugin folders, such as one a development copy and an
   * instance share. Relative paths start at the app folder; `~` is the home folder.
   */
  pluginDirs?: string[]
}

export interface ManagerOptions {
  configPath: string
  config: InstanceConfig
  /** `node_modules` directories searched for plugin packages. */
  nodeModules: string[]
  /** Directories holding local plugin folders; the config's `pluginDirs` come after them. */
  localDirs: string[]
  /** The app folder, where relative `pluginDirs` start; the config file's folder by default. */
  baseDir?: string
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

/** The top-level config fields a plugin marks as secret, with `field(…, { secret: true })`. */
export function secretFields(plugin: Plugin): string[] {
  const properties: Record<string, JsonSchema> = pluginSchema(plugin)?.properties ?? {}
  return Object.keys(properties).filter((key) => properties[key]?.['x-secret'] === true)
}

/** A config with the plain values of `keys` masked, for lists. `${NAME}` references show where the value is. */
export function maskSecrets<T extends Record<string, any>>(config: T, keys: string[]): T {
  if (!keys.length) return config
  const next: Record<string, any> = { ...config }
  for (const key of keys) {
    if (typeof next[key] === 'string' && next[key] && envReference(next[key]) === undefined) next[key] = mask(next[key])
  }
  return next as T
}

/** A config sent back from a form: masked values keep what was saved before. */
export function restoreMasked<T extends Record<string, any>>(config: T, previous: Record<string, any> | undefined, keys: string[]): T {
  if (!keys.length) return config
  const next: Record<string, any> = { ...config }
  for (const key of keys) {
    if (isMasked(next[key])) next[key] = previous?.[key]
  }
  return next as T
}

export function validatePluginConfig(plugin: Plugin, config: unknown) {
  const schema = (plugin as any).Config
  if (!schema || typeof schema !== 'object' || !('_zod' in schema)) return config
  const result = (schema as z.ZodType).safeParse(resolveEnvReferences(config ?? {}))
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
  /** Entries whose package could not be imported, such as one that is no longer installed. */
  private loadErrors = new Map<string, string>()
  /** The version of each local plugin folder's files, so a reload after an edit imports them afresh. */
  private versions = new Map<string, { stamp: string; version: number }>()

  constructor(ctx: Context, public options: ManagerOptions) {
    super(ctx, 'manager')
    this.home = ctx
  }

  private envFile?: EnvFile

  /** The instance's `.env`, where secret config fields are kept. */
  private get env() {
    return this.envFile ??= new EnvFile(join(dirname(this.options.configPath), '.env')).loadSync()
  }

  /** Moves the plain values of an entry's secret fields into `.env`, leaving `${NAME}` references. */
  private async secure(entry: PluginEntry, plugin: Plugin, config: Record<string, any>, previous?: Record<string, any>) {
    const keys = secretFields(plugin)
    if (!keys.length) return config
    return (await this.env.moveIn(config, { keys, name: [entry.id], previous })).config
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

  /** Every folder local plugins load from: the launcher's, then the config's `pluginDirs`. */
  get localDirs() {
    const base = this.options.baseDir ?? dirname(this.options.configPath)
    const extra = (this.options.config.pluginDirs ?? []).filter(Boolean).map((dir) => resolve(base, dir.replace(/^~(?=$|[\\/])/, homedir())))
    return [...new Set([...this.options.localDirs, ...extra])]
  }

  catalog(refresh = false) {
    if (refresh || !this.catalogCache) {
      this.catalogCache = scanCatalog(this.options.nodeModules, this.localDirs)
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

  /**
   * Imports a plugin package. Catalogued packages load from their own directory. A local one carries the version of
   * its files in the URL (`?mushin-v=<n>`), which goes up when a file changed, so loading it again runs the new code.
   */
  async loadPlugin(name: string): Promise<Plugin> {
    const entry = await this.findPackage(name)
    if (!entry) return unwrapPlugin(await this.options.importer(name))
    const pkg = await readPackageJson(entry.path)
    const file = resolvePackageEntry(entry.path, pkg ?? {})
    const url = pathToFileURL(file).href
    if (!entry.local) return unwrapPlugin(await this.options.importer(url))
    const stamp = await folderStamp(entry.path)
    const known = this.versions.get(entry.path)
    const version = !known ? 0 : known.stamp === stamp ? known.version : known.version + 1
    this.versions.set(entry.path, { stamp, version })
    return unwrapPlugin(await this.options.importer(`${url}?mushin-v=${version}`))
  }

  /** The local plugin folders, each with the plugins found in it. */
  async folders() {
    const catalog = await this.catalog(true)
    return Promise.all(this.localDirs.map(async (path) => ({
      path,
      /** From the config's pluginDirs, rather than the app's own plugins/ folder. */
      extra: !this.options.localDirs.includes(path),
      exists: await stat(path).then((info) => info.isDirectory(), () => false),
      plugins: catalog.filter((item) => item.local && isInside(path, item.path)).map((item) => item.package),
    })))
  }

  /** Sets the config's `pluginDirs`, rescans, and starts enabled entries whose package turned up. */
  async setFolders(dirs: string[]) {
    const list = [...new Set(dirs.map((dir) => dir.trim()).filter(Boolean))]
    if (list.length) this.options.config.pluginDirs = list
    else delete this.options.config.pluginDirs
    await this.save()
    this.logger.info('plugin folders: %s', this.localDirs.join(', '))
    await this.graph(true)
    for (const entry of this.entries) {
      if (entry.enabled === false || this.fibers.has(entry.id) || !(this.loadErrors.has(entry.id) || this.blocked.has(entry.id))) continue
      if (!this.catalogList.some((item) => item.package === entry.package)) continue
      await this.start(entry).catch((error) => this.logger.error('failed to load %s: %s', entry.package, error))
    }
    await this.retryBlocked()
    this.home.emit('manager/changed', '')
    return this.folders()
  }

  get(id: string) {
    return this.entries.find((entry) => entry.id === id)
  }

  status(id: string): { status: PluginStatus; error?: string; missing?: MissingDependency[] } {
    const blocked = this.blocked.get(id)
    if (blocked) return { status: 'missing', error: describeMissing(blocked), missing: blocked }
    const fiber = this.fibers.get(id)
    const loadError = this.loadErrors.get(id)
    if (loadError && !fiber) return { status: 'failed', error: loadError }
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
    let plugin: Plugin
    try {
      plugin = await this.loadPlugin(entry.package)
      this.loadErrors.delete(entry.id)
    } catch (error) {
      this.loadErrors.set(entry.id, loadErrorMessage(entry.package, error))
      this.home.emit('manager/changed', entry.id)
      throw error
    }
    // A key typed into mushin.config.json by hand moves to .env on the next start.
    if (entry.config) {
      const secured = await this.secure(entry, plugin, entry.config, entry.config)
      if (secured !== entry.config && JSON.stringify(secured) !== JSON.stringify(entry.config)) {
        entry.config = secured
        await this.save()
        this.logger.info('moved the secret settings of %s to .env', entry.id)
      }
    }
    for (const { service, provider } of undeclaredServices(this.graphNow(), entry.package, plugin)) {
      const local = this.catalogList.find((item) => item.package === entry.package)?.local
      // Mostly useful to plugin authors, whose plugins are usually local while they work on them.
      this.logger[local ? 'warn' : 'debug']('%s injects "%s" but does not declare %s in its manifest\'s requires or optional', entry.package, service, provider)
    }
    // Let the old instance release its resources (e.g. the server's port) before the new one starts.
    await this.fibers.get(entry.id)?.dispose()
    // `${NAME}` values come from the instance's .env file.
    const fiber = this.home.plugin(plugin, resolveEnvReferences(entry.config ?? {}))
    this.fibers.set(entry.id, fiber)
    this.home.emit('manager/changed', entry.id)
    return fiber
  }

  private async stop(id: string) {
    const fiber = this.fibers.get(id)
    const cleared = this.loadErrors.delete(id)
    if (this.blocked.delete(id) || cleared) this.home.emit('manager/changed', id)
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

  /**
   * Takes an entry out of the config, with its settings. An enabled entry is disabled first, under the same
   * rules as `disable`: essential plugins stay, and plugins that require it are refused unless `cascade` is set.
   */
  async remove(id: string, options: { cascade?: boolean } = {}) {
    const entry = this.require(id)
    if (entry.enabled !== false) await this.disable(id, options)
    else await this.assertNotEssential(entry)
    await this.stop(id)
    this.entries.splice(this.entries.indexOf(entry), 1)
    await this.save()
    this.logger.info('removed %s (%s)', id, entry.package)
    this.home.emit('manager/changed', id)
    return { id, package: entry.package }
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

  async configure(id: string, input: Record<string, any>) {
    const entry = this.require(id)
    const plugin = await this.loadPlugin(entry.package)
    const config = restoreMasked(input, entry.config, secretFields(plugin))
    validatePluginConfig(plugin, config)
    entry.config = await this.secure(entry, plugin, config, entry.config)
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
    let secrets: string[] = []
    try {
      const plugin = await this.loadPlugin(entry.package)
      configSchema = pluginSchema(plugin)
      secrets = secretFields(plugin)
    } catch {}
    const report = dependencyReport(this.graphNow(), entry.package)
    return {
      id: entry.id,
      package: entry.package,
      enabled: entry.enabled !== false,
      config: maskSecrets(entry.config ?? {}, secrets),
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
      name: 'plugins.folders',
      description: 'The folders local plugins load from (the app\'s plugins/ folder, then the extra ones in pluginDirs of mushin.config.json), with whether each exists and the plugin packages found in it.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.folders(),
    })

    yield actions.define({
      name: 'plugins.folders.set',
      description: 'Set the extra folders local plugins load from, besides the app\'s plugins/ folder (pluginDirs in mushin.config.json), for example one folder that a development copy and an instance share. Replaces the list; an empty list removes them. Relative paths start at the app folder. The code in these folders runs as part of Mushin.js.',
      risk: 'dangerous',
      input: z.object({ dirs: z.array(z.string().min(1)).max(20) }),
      handler: ({ dirs }) => this.setFolders(dirs),
    })

    yield actions.define({
      name: 'plugins.dependencies',
      description: 'What a plugin package needs and what needs it: required and optional plugins with whether each is installed, fits the version range and is enabled; the plugins that depend on it; the app plugins enabling it would also enable; and the ones disabling it would also disable. Read this before enabling or disabling a plugin.',
      risk: 'read',
      input: z.object({ package: z.string().describe('Package name, e.g. @mushinjs/plugin-flows') }),
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
      name: 'plugins.remove',
      description: 'Remove an app plugin entry from the config, settings included, for example one whose package is no longer installed. An enabled entry is disabled first, under the same rules as plugins.disable (essential plugins stay; plugins that require it need cascade). The package stays installed and can be enabled again with default settings.',
      risk: 'dangerous',
      input: entryInput.extend({ cascade: z.boolean().optional().describe('Also disable the plugins that require it') }),
      handler: ({ id, cascade }) => this.remove(id, { cascade }),
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

const isInside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const SKIP_STAMP = new Set(['node_modules', '.git'])

/** When the files of a folder last changed, as one string: file count, newest modification time and total size. */
async function folderStamp(root: string) {
  let count = 0
  let newest = 0
  let size = 0
  const walk = async (dir: string, depth: number) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) {
        if (depth < 8 && !SKIP_STAMP.has(entry.name)) await walk(join(dir, entry.name), depth + 1)
      } else if (entry.isFile()) {
        const info = await stat(join(dir, entry.name)).catch(() => undefined)
        if (!info) continue
        count++
        size += info.size
        newest = Math.max(newest, info.mtimeMs)
      }
    }
  }
  await walk(root, 0)
  return `${count}:${newest}:${size}`
}

/** Why a package could not be imported, in one line: a missing package says so plainly. */
function loadErrorMessage(name: string, error: unknown) {
  if ((error as any)?.code === 'ERR_MODULE_NOT_FOUND' && String((error as Error).message).includes(`'${name}'`)) return `${name} is not installed`
  return error instanceof Error ? error.message : String(error)
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
