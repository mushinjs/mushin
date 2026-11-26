import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type InstanceConfig, readJson, supervisor } from '@mushinjs/core'
import { readAdminToken, resetAdminToken, type SignInInfo } from '@mushinjs/plugin-console'
import { LAYOUT_VERSION, migrateLayout } from '@mushinjs/plugin-storage'
import { AGENT_FILES, defaultAgentIds, parseAgentIds, refreshAgentFiles, writeAgentFiles } from './agents'
import { mcpConfig, runBridge } from './mcp'
import { multiSelect } from './prompt'
import { appPackageManager, appPackages, CLI_VERSION, newPlugin, run, upgradeCommand, upgradeTag } from './scaffold'
import { installSkills, SKILLS_TARGET } from './skills'
import { instanceDirs, LOG_LEVEL_ENV, LOG_LEVELS, parseLogLevel, start } from './start'
import { testCommand } from './test'

const usage = `Usage: mushin <command> [options]

Commands:
  start           Start Mushin.js (default)
  open            Open the dashboard in the browser, signed in; works while Mushin.js runs in another terminal
  token reset     Create a new admin token for the dashboard
  test            Run the saved test cases of every flow, offline; exits with 1 when one fails
  migrate         Move a data folder from an older version to the current layout (start does this too)
  new plugin <name>
                  Create a TypeScript plugin in plugins/<name> and turn it on
  upgrade         Update the @mushinjs packages of this app, then migrate its data; stop Mushin.js first
  mcp             An MCP server over stdio for the AI tool in this folder; it forwards to the running Mushin.js
  skills          Put the official skills for AI tools into .claude/skills/, replacing older copies
  agents          Write the guide for coding agents (AGENTS.md, CLAUDE.md…); asks which files unless --files is given

Options:
  -d, --dir <path>   Instance directory (default: the current directory, or ./instance if it holds one)
  -p, --port <port>  Override the server port
  --log-level <level>
                     start: what the terminal shows, ${LOG_LEVELS.join(', ')} (default: info while starting,
                     then warn; also ${LOG_LEVEL_ENV} in the shell or .env)
  --no-supervisor    start: run in this one process; restarting and updating from the dashboard need the supervisor
  --flow <id|name>   test: only this flow
  --json             test: print the results as JSON
  --dry-run          migrate: only list the moves
  --tag <tag>        upgrade: the npm dist-tag to follow (default: next for a preview, latest otherwise)
  --files <list>     agents: which files, comma-separated: ${AGENT_FILES.map((file) => file.id).join(', ')}, or none
  -h, --help         Show this help`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', short: 'd' },
    port: { type: 'string', short: 'p' },
    help: { type: 'boolean', short: 'h' },
    flow: { type: 'string' },
    json: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    tag: { type: 'string' },
    files: { type: 'string' },
    'log-level': { type: 'string' },
  },
})

const CONFIG = 'mushin.config.json'

/** The instance directory: `--dir`, else the current directory, else `./instance` when that is where an instance lives. */
function instanceDir() {
  if (values.dir) return resolve(values.dir)
  if (!existsSync(CONFIG) && existsSync(join('instance', CONFIG))) return resolve('instance')
  return resolve('.')
}

/**
 * Where the user typed the command. A package script (`pnpm dev`, `npm start`) runs in the package's folder,
 * and the package manager puts the folder it was started from in INIT_CWD.
 */
function userDir() {
  return process.env.npm_lifecycle_event && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd()
}

/** How to point the CLI at this instance from where the user is, for messages. */
function dirFlag(dir: string) {
  const path = relative(userDir(), dir) || '.'
  return path === '.' ? '' : ` --dir ${path.includes(' ') ? JSON.stringify(path) : path}`
}

/**
 * A `mushin` command line that runs as-is where the user is. Started through a package script, `mushin`
 * is usually not on the PATH, so the command goes through the same package manager.
 */
function mushinCommand(args: string, dir: string) {
  let runner = 'mushin'
  if (process.env.npm_lifecycle_event) {
    const agent = process.env.npm_config_user_agent ?? ''
    runner = agent.startsWith('pnpm') ? 'pnpm exec mushin' : agent.startsWith('yarn') ? 'yarn mushin' : agent.startsWith('bun') ? 'bunx mushin' : 'npx mushin'
  }
  return `${runner} ${args}${dirFlag(dir)}`
}

/** The dashboard address from the server entry of mushin.config.json, as a browser on this machine reaches it. */
function serverUrl(config: InstanceConfig, port?: string) {
  const server = config.plugins.find((entry) => entry.package === '@cordisjs/plugin-server')
  const host = server?.config?.host === '0.0.0.0' || !server?.config?.host ? '127.0.0.1' : server.config.host
  return `http://${host}:${port ?? server?.config?.port ?? 5160}`
}

/** Opens a link in the default browser; false when there is no way to. */
function openBrowser(url: string) {
  const [command, args, verbatim] = process.platform === 'win32'
    // `start` is built into cmd. Its first quoted argument is the window title, so an empty one comes first.
    ? ['cmd', ['/c', 'start', '""', `"${url}"`], true]
    : process.platform === 'darwin' ? ['open', [url], false] : ['xdg-open', [url], false]
  return new Promise<boolean>((resolve) => {
    const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true, windowsVerbatimArguments: verbatim as boolean })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}

function signInLink(url: string, token: string) {
  return `${url}/login#token=${encodeURIComponent(token)}`
}

function printSignIn(info: SignInInfo, dir: string) {
  const lines = ['', `  Mushin.js dashboard: ${info.url}`]
  if (info.fromEnv) {
    lines.push('  Sign in with the token from the MUSHIN_ADMIN_TOKEN environment variable.')
  } else {
    lines.push(
      `  Sign in:     ${signInLink(info.url, info.token)}`,
      `  Admin token: ${info.token}`,
      `  New token:   ${mushinCommand('token reset', dir)}`,
    )
  }
  lines.push(`  Open again:  ${mushinCommand('open', dir)}`)
  console.log(lines.join('\n') + '\n')
}

const [command = 'start', sub] = positionals
const baseDir = instanceDir()

if (values.help) {
  console.log(usage)
} else if (command === 'start') {
  // An app made before the official skills existed gets them; ones already there are left as they are.
  // The agent guide names the folder and version, so it follows a move or an upgrade.
  if ((await appPackages(baseDir))?.length) {
    await installSkills(baseDir).catch(() => {})
    await refreshAgentFiles(baseDir).catch(() => {})
  }
  let logLevel
  try {
    logLevel = parseLogLevel(values['log-level'])
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
  let signIn: SignInInfo | undefined
  const instance = await start({
    baseDir,
    port: values.port ? Number(values.port) : undefined,
    logLevel,
    onSignIn: (info) => {
      signIn = info
      // Under the supervisor (see supervisor.ts): the app is up, and it stops when asked.
      supervisor()?.send({ type: 'ready', version: CLI_VERSION }).catch(() => {})
    },
  })
  const signedIn = () => !!signIn
  // Asked by the supervisor, or it went away; Ctrl+C reaches this process as well, so only the first one counts.
  supervisor()?.on('shutdown', () => !stopping && shutdown())
  // Without a server nothing keeps the process alive, so it would exit silently; say why instead.
  const watchdog = setInterval(() => {
    if (signedIn()) return clearInterval(watchdog)
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
  // The sign-in block comes last, once the plugins and bots have started and printed their lines.
  await instance.started
  if (signIn && !stopping) printSignIn(signIn, baseDir)
} else if (command === 'open') {
  const config = await readJson<InstanceConfig>(join(baseDir, CONFIG))
  if (!config) {
    console.error(`No Mushin.js instance in ${baseDir}. Pass the instance folder with --dir.`)
    process.exit(1)
  }
  // Only reads .env, so it is safe while Mushin.js runs.
  const token = readAdminToken(baseDir)
  if (!token) {
    console.error(`This app has no admin token yet. Start Mushin.js once, or create one with "${mushinCommand('token reset', baseDir)}".`)
    process.exit(1)
  }
  const link = signInLink(serverUrl(config, values.port), token)
  console.log(`Sign in: ${link}`)
  if (!await openBrowser(link)) console.log('Could not open a browser here; open the link above yourself.')
} else if (command === 'test') {
  if (!existsSync(join(baseDir, CONFIG))) {
    console.error(`No Mushin.js instance in ${baseDir}. Pass the instance folder with --dir.`)
    process.exit(1)
  }
  process.exit(await testCommand({ baseDir, flow: values.flow, json: values.json }))
} else if (command === 'migrate') {
  const config = await readJson<InstanceConfig>(join(baseDir, CONFIG))
  if (!config) {
    console.error(`No Mushin.js instance in ${baseDir}. Pass the instance folder with --dir.`)
    process.exit(1)
  }
  const dirs = instanceDirs(baseDir, config)
  const result = await migrateLayout(dirs, { dryRun: values['dry-run'] })
  for (const move of result.moves) console.log(`  ${relative(baseDir, move.from)} → ${relative(baseDir, move.to)}`)
  if (!result.moves.length) console.log(`The data folder already uses the current layout (version ${LAYOUT_VERSION}). Nothing to move.`)
  else if (values['dry-run']) console.log(`${result.moves.length} file(s) would move. Run without --dry-run to move them; a copy of the data folder is made first.`)
  else console.log(`Moved ${result.moves.length} file(s). A copy of the old data folder is in ${relative(baseDir, result.backup!)}.`)
} else if (command === 'token' && sub === 'reset') {
  const config = await readJson<InstanceConfig>(join(baseDir, CONFIG))
  if (!config) {
    console.error(`No Mushin.js instance in ${baseDir}. Pass the instance folder with --dir, e.g. "mushin token reset --dir instance".`)
    process.exit(1)
  }
  await migrateLayout(instanceDirs(baseDir, config))
  const token = await resetAdminToken(baseDir)
  console.log(`New admin token: ${token}`)
  console.log(`Sign in: ${signInLink(serverUrl(config), token)}`)
  console.log('A running Mushin.js accepts the new token right away; the old one stops working.')
} else if (command === 'new' && sub === 'plugin') {
  const name = positionals[2]
  if (!name) {
    console.error('Name the plugin: mushin new plugin <name>')
    process.exit(1)
  }
  try {
    const created = await newPlugin(baseDir, name)
    console.log(`Created ${relative(process.cwd(), created.dir) || '.'} (${created.package}).`)
    console.log(created.added ? 'It is turned on in mushin.config.json and starts with Mushin.js; a running Mushin.js picks it up after a restart.' : 'It is already listed in mushin.config.json.')
    console.log(`Edit src/index.ts, then check it with "${appPackageManager(baseDir)} run typecheck".`)
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
} else if (command === 'skills') {
  const { added, updated } = await installSkills(baseDir, { overwrite: true })
  const changed = [...added.map((name) => `added ${name}`), ...updated.map((name) => `updated ${name}`)]
  console.log(changed.length ? `${SKILLS_TARGET}: ${changed.join(', ')}.` : `The official skills in ${SKILLS_TARGET} are up to date.`)
  // The guide lists the skills, so it changes with them.
  const guides = await refreshAgentFiles(baseDir, { legacy: true })
  if (guides.length) console.log(`Updated the agent guide in ${guides.join(', ')}.`)
} else if (command === 'agents') {
  let ids: string[] = []
  try {
    ids = values.files !== undefined ? parseAgentIds(values.files) : await defaultAgentIds(baseDir)
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
  if (values.files === undefined && process.stdin.isTTY && process.stdout.isTTY) {
    const chosen = await multiSelect(
      'Which coding agent instruction files should Mushin.js create?',
      AGENT_FILES.map((file) => ({ value: file.id, label: file.path, hint: file.tools })),
      ids,
    )
    if (!chosen) process.exit(130)
    ids = chosen
  }
  const written = await writeAgentFiles(baseDir, ids)
  if (!ids.length) console.log('No agent files chosen.')
  else console.log(written.length ? `Wrote the agent guide to ${written.join(', ')}.` : 'The agent guide is up to date.')
} else if (command === 'mcp') {
  await runBridge({ baseDir, port: values.port ? Number(values.port) : undefined })
} else if (command === 'upgrade') {
  const packages = await appPackages(baseDir)
  if (!packages?.length) {
    console.error(`${baseDir} has no package.json that depends on @mushinjs packages. "mushin upgrade" works in an app made with "npm create mushin".`)
    process.exit(1)
  }
  const tag = values.tag ?? upgradeTag()
  const [pm, args] = upgradeCommand(appPackageManager(baseDir), packages, tag)
  console.log(`Mushin.js ${CLI_VERSION}: updating ${packages.join(', ')} to ${tag}. Stop Mushin.js first if it is running.`)
  try {
    await run(pm, args, baseDir)
    // The new version decides the layout, so its own CLI moves the data.
    const bin = join(baseDir, 'node_modules', '@mushinjs', 'cli', 'bin', 'mushin.js')
    if (existsSync(join(baseDir, CONFIG)) && existsSync(bin)) await run(process.execPath, [bin, 'migrate', '--dir', baseDir], baseDir)
    // The new version's skills replace the old ones.
    if (existsSync(bin)) await run(process.execPath, [bin, 'skills', '--dir', baseDir], baseDir)
    const after = await readJson<{ version: string }>(join(baseDir, 'node_modules', '@mushinjs', 'cli', 'package.json'))
    // Apps made before the MCP server get the file that connects their AI tool to it.
    if (!existsSync(join(baseDir, '.mcp.json'))) {
      await writeFile(join(baseDir, '.mcp.json'), JSON.stringify(mcpConfig(), null, 2) + '\n')
      console.log('Added .mcp.json, which connects the AI tool you open in this folder to Mushin.js.')
    }
    console.log(`Mushin.js is now ${after?.version ?? 'updated'}. Start it with "${appPackageManager(baseDir)} start".`)
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
} else {
  console.error(usage)
  process.exit(1)
}
