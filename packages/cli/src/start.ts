import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Actions, Context, currentPackageName, EnvFile, type Exporter, type InstanceConfig, Logger, type Message, MushinError, PluginManager, readJson, resolveEnvReferences, writeJsonAtomic, z } from '@mushinjs/core'
import type { SignInInfo } from '@mushinjs/plugin-console'
import { type LayoutDirs, migrateLayout, resolveDirs } from '@mushinjs/plugin-storage'
import { registerPluginHooks } from './hooks'
import { clock, RepeatedLines, summaryText } from './log-repeats'
import { createPluginFolder, PLUGIN_NAME } from './scaffold'

export const DEFAULT_PORT = 5160

/** True when this file runs as TypeScript: from the repository's sources, where tsx is already loaded. */
const fromSource = import.meta.url.endsWith('.ts')
let tsx: Promise<unknown> | undefined

/**
 * Imports a plugin entry. Published packages are JavaScript; a plugin in the instance's plugins/ folder may be
 * TypeScript, so tsx starts the first time one is imported, and an instance without one never loads it.
 */
export async function importPlugin(specifier: string) {
  if (!fromSource && /\.[cm]?tsx?(?:\?|$)/.test(specifier)) {
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
      { id: 'adapter-qq', package: '@mushinjs/plugin-adapter-qq', config: {} },
      { id: 'adapter-telegram', package: '@mushinjs/plugin-adapter-telegram', config: {} },
      { id: 'adapter-discord', package: '@mushinjs/plugin-adapter-discord', config: {} },
      { id: 'adapter-kook', package: '@mushinjs/plugin-adapter-kook', config: {} },
      { id: 'flows', package: '@mushinjs/plugin-flows', config: {} },
      { id: 'knowledge', package: '@mushinjs/plugin-knowledge', config: {} },
      { id: 'fairy', package: '@mushinjs/plugin-fairy', config: {} },
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

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const
export type LogLevel = typeof LOG_LEVELS[number]
export const LOG_LEVEL_ENV = 'MUSHIN_LOG_LEVEL'

/** A log level from `--log-level` or MUSHIN_LOG_LEVEL; an unknown value is an error that names the choices. */
export function parseLogLevel(value: string | undefined, from = '--log-level'): LogLevel | undefined {
  if (value === undefined || value === '') return undefined
  const level = value.trim().toLowerCase()
  if ((LOG_LEVELS as readonly string[]).includes(level)) return level as LogLevel
  throw new MushinError('invalid_input', `${from} must be one of ${LOG_LEVELS.join(', ')}, not "${value}"`)
}

/**
 * Prints `HH:MM:SS [I] name message` lines, colored when stdout is a terminal. A warning or error that
 * repeats prints once, then as a count (see log-repeats.ts). Its `levels.default` is read on every line,
 * so changing it takes effect at once.
 */
function consoleExporter(level: LogLevel) {
  const colors = process.stdout.isTTY
  const repeats = new RepeatedLines()
  const write = (type: string, name: string, time: string, text: string) => {
    const [label, color] = levelLabels[type] ?? ['?', 0]
    const tag = colors ? `\x1b[${color}m[${label}]\x1b[0m` : `[${label}]`
    const source = colors ? `\x1b[1m${name}\x1b[0m` : name
    const stream = type === 'error' ? process.stderr : process.stdout
    stream.write(`${time} ${tag} ${source} ${text}\n`)
  }
  const exporter = {
    colors: colors ? 3 : false,
    levels: { default: LOG_LEVELS.indexOf(level) },
    export(message: Message) {
      const line = { type: message.type, name: message.name, ts: message.ts, text: Logger.format(exporter, message) }
      for (const out of repeats.handle(line)) {
        if (out.kind === 'line') write(out.line.type, out.line.name, clock(out.line.ts), out.line.text)
        else write(out.type, out.name, clock(Date.now()), colors ? `\x1b[2m${summaryText(out)}\x1b[0m` : summaryText(out))
      }
    },
  } satisfies Exporter & { levels: Record<string, number> }
  return exporter
}

/**
 * Resolves once every plugin entry has settled (active, failed, disabled or missing a dependency), or after
 * `timeout` ms, so one plugin that never finishes does not hold up the rest.
 */
function whenSettled(ctx: Context, timeout = 30_000) {
  return new Promise<void>((resolve) => {
    // A stopped instance has no manager left; nothing more is coming.
    const settled = () => !ctx.manager || ctx.manager.entries.every((entry) => !['pending', 'loading'].includes(ctx.manager.status(entry.id).status))
    const done = () => {
      clearInterval(timer)
      clearTimeout(limit)
      resolve()
    }
    const timer = setInterval(() => settled() && done(), 100).unref()
    const limit = setTimeout(done, timeout).unref()
    if (settled()) done()
  })
}

export interface StartOptions {
  baseDir: string
  /** Overrides the server port from the config file, for tests and side-by-side instances. */
  port?: number
  quiet?: boolean
  /**
   * What the terminal shows, the whole time. Without it (or MUSHIN_LOG_LEVEL), startup prints info lines and
   * then only warnings and errors; the dashboard's Logs page has the rest.
   */
  logLevel?: LogLevel
  /** Called when the dashboard is up, with the sign-in link details. */
  onSignIn?: (info: SignInInfo) => void
  /**
   * For `mushin test`: bots stay offline, the web server, dashboard, Fairy, MCP servers and
   * statistics do not load, the database lives in memory, and the config file is never written.
   */
  offline?: boolean
}

/** Plugins `mushin test` leaves out: they serve people or reach other programs, and flows do not need them. */
const OFFLINE_SKIP = new Set(['@cordisjs/plugin-server', '@mushinjs/plugin-console', '@mushinjs/plugin-fairy', '@mushinjs/plugin-mcp', '@mushinjs/plugin-stats'])

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

/** `plugins.new`: a new local plugin from the template, for Fairy and the dashboard. */
function definePluginTemplate(ctx: Context, baseDir: string) {
  ctx.actions.define({
    name: 'plugins.new',
    description: 'Create a new local plugin from the template: <folder>/<name>/package.json (package mushin-plugin-<name>) and src/index.ts, a TypeScript plugin with one example action <name>.hello that Mushin.js runs without a build step. Then turn it on, unless enable is false. Read src/index.ts before changing it; after changing it, plugins.reload with its entry id runs the new code.',
    risk: 'write',
    input: z.object({
      name: z.string().regex(PLUGIN_NAME).describe('Lowercase letters, digits and dashes, starting with a letter, e.g. weather'),
      folder: z.string().optional().describe('A folder from plugins.folders; the app\'s plugins/ folder by default'),
      enable: z.boolean().default(true),
    }),
    handler: async ({ name, folder, enable }) => {
      const manager = ctx.get('manager')
      if (!manager) throw new MushinError('unavailable', 'The plugin manager is not running')
      const dirs = manager.localDirs
      const parent = folder ? dirs.find((dir) => dir === resolve(baseDir, folder)) : dirs[0]
      if (!parent) throw new MushinError('invalid_input', `${folder} is not a plugin folder; plugins.folders lists them (${dirs.join(', ')})`)
      const pkg = `mushin-plugin-${name}`
      if ((await manager.catalog(true)).some((item) => item.package === pkg)) throw new MushinError('conflict', `A plugin named ${pkg} is already installed; pick another name`)
      const created = await createPluginFolder(parent, name).catch((error: Error) => {
        throw new MushinError('conflict', error.message)
      })
      await manager.graph(true)
      const entry = enable ? await manager.describe(await manager.enable(pkg)) : undefined
      return { ...created, files: created.files.map((file) => join(created.dir, file)), ...(entry ? { entry } : {}) }
    },
  })
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
  let chosenLevel = options.logLevel
  try {
    chosenLevel ??= parseLogLevel(process.env[LOG_LEVEL_ENV], LOG_LEVEL_ENV)
  } catch (error) {
    if (!options.quiet) console.warn(`${(error as Error).message}; using the default.`)
  }
  const terminal = options.quiet ? undefined : consoleExporter(chosenLevel ?? 'info')
  if (terminal) ctx.logger.exporter(terminal)

  if (options.onSignIn) ctx.on('console/ready', options.onSignIn)

  // Local plugins, also in folders outside the app, import the app's packages and reload with fresh code.
  registerPluginHooks([pathToFileURL(join(baseDir, 'package.json')).href, import.meta.url])

  const actions = ctx.plugin(Actions)
  await actions
  definePluginTemplate(ctx, baseDir)
  const manager = ctx.plugin(PluginManager, {
    // Offline runs change the plugin list in memory; saving it would lose the real one.
    configPath: options.offline ? join(await mkdtemp(join(tmpdir(), 'mushin-offline-')), 'mushin.config.json') : configPath,
    config,
    nodeModules: [
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(baseDir, 'node_modules'),
    ],
    localDirs: [join(baseDir, 'plugins')],
    baseDir,
    importer: importPlugin,
  })
  await manager

  const started = whenSettled(ctx).then(() => {
    if (!terminal || chosenLevel) return
    // Startup is done: from here on the terminal shows warnings and errors, and says where the rest is.
    terminal.levels.default = LOG_LEVELS.indexOf('warn')
    const note = `Startup done. From now on this terminal shows warnings and errors only; the full log is on the dashboard's Logs page. To see everything here, start with --log-level info (or set ${LOG_LEVEL_ENV}=info in .env).`
    console.log(process.stdout.isTTY ? `\x1b[2m${note}\x1b[0m` : note)
  })

  return {
    ctx,
    /** Resolves once every plugin has finished starting (or failed to). */
    started,
    async stop() {
      await manager.dispose()
      await actions.dispose()
    },
  }
}
