import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Actions, Context, currentPackageName, EnvFile, type Exporter, type InstanceConfig, Logger, type Message, PluginManager, readJson, resolveEnvReferences, writeJsonAtomic } from '@mushinjs/core'
import type { SignInInfo } from '@mushinjs/plugin-console'
import { type LayoutDirs, migrateLayout, resolveDirs } from '@mushinjs/plugin-storage'

export const DEFAULT_PORT = 5160

/** True when this file runs as TypeScript: from the repository's sources, where tsx is already loaded. */
const fromSource = import.meta.url.endsWith('.ts')
let tsx: Promise<unknown> | undefined

/**
 * Imports a plugin entry. Published packages are JavaScript; a plugin in the instance's plugins/ folder may be
 * TypeScript, so tsx starts the first time one is imported, and an instance without one never loads it.
 */
export async function importPlugin(specifier: string) {
  if (!fromSource && /\.[cm]?tsx?$/.test(specifier)) {
    tsx ??= import('tsx/esm/api').then(({ register }) => register())
    await tsx
  }
  return import(specifier)
}

export function defaultConfig(): InstanceConfig {
  return {
    plugins: [
      { id: 'server', package: '@cordisjs/plugin-server', config: { host: '127.0.0.1', port: DEFAULT_PORT } },
      { id: 'storage', package: '@mushinjs/plugin-storage', config: {} },
      { id: 'database', package: '@mushinjs/plugin-database', config: {} },
      { id: 'providers', package: '@mushinjs/plugin-providers', config: {} },
      { id: 'provider-openai', package: '@mushinjs/plugin-provider-openai', config: {} },
      { id: 'provider-anthropic', package: '@mushinjs/plugin-provider-anthropic', config: {} },
      { id: 'provider-gemini', package: '@mushinjs/plugin-provider-gemini', config: {} },
      { id: 'provider-typesafe', package: '@mushinjs/plugin-provider-typesafe', config: {} },
      { id: 'bots', package: '@mushinjs/plugin-bots', config: {} },
      { id: 'permissions', package: '@mushinjs/plugin-permissions', config: {} },
      { id: 'personas', package: '@mushinjs/plugin-personas', config: {} },
      { id: 'adapter-onebot', package: '@mushinjs/plugin-adapter-onebot', config: {} },
      { id: 'flows', package: '@mushinjs/plugin-flows', config: {} },
      { id: 'knowledge', package: '@mushinjs/plugin-knowledge', config: {} },
      { id: 'agent', package: '@mushinjs/plugin-agent', config: {} },
      { id: 'mcp', package: '@mushinjs/plugin-mcp', config: {} },
      { id: 'stats', package: '@mushinjs/plugin-stats', config: {} },
      { id: 'console', package: '@mushinjs/plugin-console', config: {} },
    ],
  }
}

const levelLabels: Record<string, [string, number]> = {
  error: ['E', 31],
  warn: ['W', 33],
  info: ['I', 36],
  debug: ['D', 90],
}

/** Prints `HH:MM:SS [I] name message` lines, colored when stdout is a terminal. */
function consoleExporter(): Exporter {
  const colors = process.stdout.isTTY
  const exporter: Exporter = {
    colors: colors ? 3 : false,
    export(message: Message) {
      const time = new Date(message.ts).toTimeString().slice(0, 8)
      const [label, color] = levelLabels[message.type] ?? ['?', 0]
      const level = colors ? `\x1b[${color}m[${label}]\x1b[0m` : `[${label}]`
      const name = colors ? `\x1b[1m${message.name}\x1b[0m` : message.name
      const stream = message.type === 'error' ? process.stderr : process.stdout
      stream.write(`${time} ${level} ${name} ${Logger.format(exporter, message)}\n`)
    },
  }
  return exporter
}

export interface StartOptions {
  baseDir: string
  /** Overrides the server port from the config file, for tests and side-by-side instances. */
  port?: number
  quiet?: boolean
  /** Called when the dashboard is up, with the sign-in link details. */
  onSignIn?: (info: SignInInfo) => void
  /**
   * For `mushin test`: bots stay offline, the web server, dashboard, Agent, MCP servers and
   * statistics do not load, the database lives in memory, and the config file is never written.
   */
  offline?: boolean
}

/** Plugins `mushin test` leaves out: they serve people or reach other programs, and flows do not need them. */
const OFFLINE_SKIP = new Set(['@cordisjs/plugin-server', '@mushinjs/plugin-console', '@mushinjs/plugin-agent', '@mushinjs/plugin-mcp', '@mushinjs/plugin-stats'])

function offlineConfig(config: InstanceConfig): InstanceConfig {
  return {
    ...config,
    plugins: config.plugins
      .filter((entry) => !OFFLINE_SKIP.has(entry.package))
      .map((entry) => (entry.package === '@mushinjs/plugin-database' ? { ...entry, config: { ...entry.config, driver: 'memory' } } : entry)),
  }
}

/** The data, log and cache folders of an instance, from its storage plugin entry. */
export function instanceDirs(baseDir: string, config: InstanceConfig): LayoutDirs {
  const storage = config.plugins.find((entry) => entry.package === '@mushinjs/plugin-storage' || entry.package === '@mushin/plugin-storage')
  // The folders may be `${NAME}` references to .env.
  new EnvFile(join(baseDir, '.env')).loadSync()
  return resolveDirs(baseDir, resolveEnvReferences(storage?.config ?? {}))
}

/** Boots an instance: root context, action registry, then every app plugin in the config file. */
export async function start(options: StartOptions) {
  const baseDir = resolve(options.baseDir)
  await mkdir(baseDir, { recursive: true })
  const configPath = join(baseDir, 'mushin.config.json')
  let config = await readJson<InstanceConfig>(configPath)
  if (!config) {
    config = defaultConfig()
    await writeJsonAtomic(configPath, config)
  } else {
    let changed = false
    for (const entry of config.plugins) {
      const name = currentPackageName(entry.package)
      if (name !== entry.package) [entry.package, changed] = [name, true]
    }
    // Built-in plugins added in newer versions join existing instances; entries the user disabled stay disabled.
    const missing = defaultConfig().plugins.filter((entry) => !config!.plugins.some((item) => item.package === entry.package))
    if (missing.length) {
      config.plugins.push(...missing)
      changed = true
    }
    if (changed) await writeJsonAtomic(configPath, config)
  }
  // Data folders from older versions move to the current layout before any plugin reads them.
  const migration = await migrateLayout(instanceDirs(baseDir, config))
  if (migration.moves.length && !options.quiet) {
    console.log(`Moved ${migration.moves.length} data file(s) to the new folder layout. A copy of the old data folder is in ${migration.backup}.`)
  }
  if (options.port !== undefined) {
    const server = config.plugins.find((entry) => entry.package === '@cordisjs/plugin-server')
    if (server) server.config = { ...server.config, port: options.port }
  }

  // Secrets in .env, for `${NAME}` references in the config and for plugins that read the environment.
  new EnvFile(join(baseDir, '.env')).loadSync()

  const ctx = new Context()
  ctx.baseDir = baseDir
  ctx.offline = !!options.offline
  if (options.offline) config = offlineConfig(config)
  if (!options.quiet) ctx.logger.exporter(consoleExporter())

  if (options.onSignIn) ctx.on('console/ready', options.onSignIn)

  const actions = ctx.plugin(Actions)
  await actions
  const manager = ctx.plugin(PluginManager, {
    // Offline runs change the plugin list in memory; saving it would lose the real one.
    configPath: options.offline ? join(await mkdtemp(join(tmpdir(), 'mushin-offline-')), 'mushin.config.json') : configPath,
    config,
    nodeModules: [
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(baseDir, 'node_modules'),
    ],
    localDirs: [join(baseDir, 'plugins')],
    importer: importPlugin,
  })
  await manager

  return {
    ctx,
    async stop() {
      await manager.dispose()
      await actions.dispose()
    },
  }
}
