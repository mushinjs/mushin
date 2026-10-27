import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type InstanceConfig, readJson } from '@mushin/core'
import { resetAdminToken, type SignInInfo } from '@mushin/plugin-console'
import { start } from './start'
import { testCommand } from './test'

const usage = `Usage: mushin <command> [options]

Commands:
  start           Start Mushin.js (default)
  token reset     Create a new admin token for the dashboard
  test            Run the saved test cases of every flow, offline; exits with 1 when one fails

Options:
  -d, --dir <path>   Instance directory (default: the current directory, or ./instance if it holds one)
  -p, --port <port>  Override the server port
  --flow <id|name>   test: only this flow
  --json             test: print the results as JSON
  -h, --help         Show this help`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', short: 'd' },
    port: { type: 'string', short: 'p' },
    help: { type: 'boolean', short: 'h' },
    flow: { type: 'string' },
    json: { type: 'boolean' },
  },
})

const CONFIG = 'mushin.config.json'

/** The instance directory: `--dir`, else the current directory, else `./instance` when that is where an instance lives. */
function instanceDir() {
  if (values.dir) return resolve(values.dir)
  if (!existsSync(CONFIG) && existsSync(join('instance', CONFIG))) return resolve('instance')
  return resolve('.')
}

/** How to point the CLI at this instance from the current directory, for messages. */
function dirFlag(dir: string) {
  const path = relative(process.cwd(), dir) || '.'
  return path === '.' ? '' : ` --dir ${path.includes(' ') ? JSON.stringify(path) : path}`
}

function signInLink(url: string, token: string) {
  return `${url}/login#token=${encodeURIComponent(token)}`
}

function printSignIn(info: SignInInfo, dir: string) {
  const lines = ['', `  Mushin.js dashboard: ${info.url}`]
  if (info.fromEnv) {
    lines.push('  Sign in with the token from MUSHIN_ADMIN_TOKEN.')
  } else {
    lines.push(
      `  Sign in:     ${signInLink(info.url, info.token)}`,
      `  Admin token: ${info.token}`,
      `  New token:   mushin token reset${dirFlag(dir)}`,
    )
  }
  console.log(lines.join('\n') + '\n')
}

const [command = 'start', sub] = positionals
const baseDir = instanceDir()

if (values.help) {
  console.log(usage)
} else if (command === 'start') {
  let signedIn = false
  const instance = await start({
    baseDir,
    port: values.port ? Number(values.port) : undefined,
    onSignIn: (info) => {
      signedIn = true
      printSignIn(info, baseDir)
    },
  })
  // Without a server nothing keeps the process alive, so it would exit silently; say why instead.
  const watchdog = setInterval(() => {
    if (signedIn) return clearInterval(watchdog)
    const server = instance.ctx.manager.entries.find((entry) => entry.package === '@cordisjs/plugin-server')
    const { status, error } = server ? instance.ctx.manager.status(server.id) : { status: 'failed', error: 'no server entry in mushin.config.json' }
    if (status !== 'failed') return
    clearInterval(watchdog)
    const port = values.port ?? server?.config?.port ?? 5160
    console.error(`\n  Mushin.js could not start its web server: ${error}`)
    if (/open ports|EADDRINUSE/i.test(String(error))) {
      console.error(`  Port ${port} is in use. Is Mushin.js already running? Stop it, or start with --port <another port>.\n`)
    }
    process.exit(1)
  }, 200)
  let stopping = false
  const shutdown = async () => {
    if (stopping) return process.exit(1)
    stopping = true
    await instance.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} else if (command === 'test') {
  if (!existsSync(join(baseDir, CONFIG))) {
    console.error(`No Mushin.js instance in ${baseDir}. Pass the instance folder with --dir.`)
    process.exit(1)
  }
  process.exit(await testCommand({ baseDir, flow: values.flow, json: values.json }))
} else if (command === 'token' && sub === 'reset') {
  const config = await readJson<InstanceConfig>(join(baseDir, CONFIG))
  if (!config) {
    console.error(`No Mushin.js instance in ${baseDir}. Pass the instance folder with --dir, e.g. "mushin token reset --dir instance".`)
    process.exit(1)
  }
  const storage = config.plugins.find((entry) => entry.package === '@mushin/plugin-storage')
  const server = config.plugins.find((entry) => entry.package === '@cordisjs/plugin-server')
  const token = await resetAdminToken(resolve(baseDir, storage?.config?.dir ?? 'data'))
  const host = server?.config?.host === '0.0.0.0' || !server?.config?.host ? '127.0.0.1' : server.config.host
  const url = `http://${host}:${server?.config?.port ?? 5160}`
  console.log(`New admin token: ${token}`)
  console.log(`Sign in: ${signInLink(url, token)}`)
  console.log('A running Mushin.js accepts the new token right away; the old one stops working.')
} else {
  console.error(usage)
  process.exit(1)
}
