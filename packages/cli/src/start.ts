import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Actions, Context, type Exporter, type InstanceConfig, Logger, type Message, PluginManager, readJson, writeJsonAtomic } from '@mushin/core'
import type { SignInInfo } from '@mushin/plugin-console'

export const DEFAULT_PORT = 5160

export function defaultConfig(): InstanceConfig {
  return {
    plugins: [
      { id: 'server', package: '@cordisjs/plugin-server', config: { host: '127.0.0.1', port: DEFAULT_PORT } },
      { id: 'storage', package: '@mushin/plugin-storage', config: {} },
      { id: 'providers', package: '@mushin/plugin-providers', config: {} },
      { id: 'provider-openai', package: '@mushin/plugin-provider-openai', config: {} },
      { id: 'provider-anthropic', package: '@mushin/plugin-provider-anthropic', config: {} },
      { id: 'bots', package: '@mushin/plugin-bots', config: {} },
      { id: 'permissions', package: '@mushin/plugin-permissions', config: {} },
      { id: 'personas', package: '@mushin/plugin-personas', config: {} },
      { id: 'adapter-onebot', package: '@mushin/plugin-adapter-onebot', config: {} },
      { id: 'flows', package: '@mushin/plugin-flows', config: {} },
      { id: 'agent', package: '@mushin/plugin-agent', config: {} },
      { id: 'stats', package: '@mushin/plugin-stats', config: {} },
      { id: 'console', package: '@mushin/plugin-console', config: {} },
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
    // Built-in plugins added in newer versions join existing instances; entries the user disabled stay disabled.
    const missing = defaultConfig().plugins.filter((entry) => !config!.plugins.some((item) => item.package === entry.package))
    if (missing.length) {
      config.plugins.push(...missing)
      await writeJsonAtomic(configPath, config)
    }
  }
  if (options.port !== undefined) {
    const server = config.plugins.find((entry) => entry.package === '@cordisjs/plugin-server')
    if (server) server.config = { ...server.config, port: options.port }
  }

  const ctx = new Context()
  ctx.baseDir = baseDir
  if (!options.quiet) ctx.logger.exporter(consoleExporter())

  if (options.onSignIn) ctx.on('console/ready', options.onSignIn)

  const actions = ctx.plugin(Actions)
  await actions
  const manager = ctx.plugin(PluginManager, {
    configPath,
    config,
    nodeModules: [
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(baseDir, 'node_modules'),
    ],
    localDirs: [join(baseDir, 'plugins')],
    importer: (specifier: string) => import(specifier),
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
