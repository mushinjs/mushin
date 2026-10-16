import { pathToFileURL } from 'node:url'
import { Context, type Fiber, type Plugin, Service } from 'cordis'
import { z } from 'zod'
import { toJsonSchema, type JsonSchema } from './actions'
import { MushinError } from './errors'
import { type CatalogEntry, type PluginManifest, readPackageJson, resolvePackageEntry, scanCatalog } from './manifest'
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

export type PluginStatus = 'disabled' | 'pending' | 'loading' | 'active' | 'failed' | 'unloading'

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

  constructor(ctx: Context, public options: ManagerOptions) {
    super(ctx, 'manager')
    this.home = ctx
  }

  get entries() {
    return this.options.config.plugins
  }

  async *[Service.init]() {
    yield this.home.on('internal/status', (fiber) => {
      for (const [id, tracked] of this.fibers) {
        if (tracked.ctx.fiber === fiber) this.home.emit('manager/changed', id)
      }
    })
    yield* this.defineActions()
    for (const entry of this.entries) {
      if (entry.enabled === false) continue
      await this.start(entry).catch((error) => {
        this.home.logger('manager').error('failed to load %s: %s', entry.package, error)
      })
    }
  }

  catalog(refresh = false) {
    if (refresh || !this.catalogCache) {
      this.catalogCache = scanCatalog(this.options.nodeModules, this.options.localDirs)
    }
    return this.catalogCache
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

  status(id: string) {
    const fiber = this.fibers.get(id)
    return { status: fiberStatus(fiber), error: fiberError(fiber) }
  }

  private async start(entry: PluginEntry) {
    const plugin = await this.loadPlugin(entry.package)
    // Let the old instance release its resources (e.g. the server's port) before the new one starts.
    await this.fibers.get(entry.id)?.dispose()
    const fiber = this.home.plugin(plugin, entry.config ?? {})
    this.fibers.set(entry.id, fiber)
    this.home.emit('manager/changed', entry.id)
    return fiber
  }

  private async stop(id: string) {
    const fiber = this.fibers.get(id)
    if (!fiber) return
    this.fibers.delete(id)
    await fiber.dispose()
    this.home.emit('manager/changed', id)
  }

  save() {
    return writeJsonAtomic(this.options.configPath, this.options.config)
  }

  async enable(name: string, id?: string) {
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
    await this.start(entry)
    return entry
  }

  async disable(id: string) {
    const entry = this.require(id)
    const manifest = (await this.findPackage(entry.package))?.manifest ?? knownManifests[entry.package]
    if (manifest?.essential) {
      throw new MushinError('forbidden', `${entry.package} is essential and cannot be disabled`)
    }
    entry.enabled = false
    await this.save()
    await this.stop(id)
    return entry
  }

  async configure(id: string, config: Record<string, any>) {
    const entry = this.require(id)
    const plugin = await this.loadPlugin(entry.package)
    validatePluginConfig(plugin, config)
    entry.config = config
    await this.save()
    if (entry.enabled !== false) await this.start(entry)
    return entry
  }

  async reload(id: string) {
    const entry = this.require(id)
    if (entry.enabled === false) throw new MushinError('conflict', `${id} is disabled`)
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
    return {
      id: entry.id,
      package: entry.package,
      enabled: entry.enabled !== false,
      config: entry.config ?? {},
      configSchema,
      manifest: catalog?.manifest ?? knownManifests[entry.package],
      version: catalog?.version,
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
      name: 'plugins.enable',
      description: 'Enable an app plugin by package name. Adds it to the config if it is not there yet.',
      risk: 'write',
      input: z.object({ package: z.string(), id: z.string().optional() }),
      handler: async (input) => this.describe(await this.enable(input.package, input.id)),
    })

    yield actions.define({
      name: 'plugins.disable',
      description: 'Disable an app plugin entry. Essential plugins cannot be disabled.',
      risk: 'write',
      input: entryInput,
      handler: async ({ id }) => this.describe(await this.disable(id)),
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
