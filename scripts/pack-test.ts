// Installs the packed packages the way a user would, outside this repository, and starts Mushin.js from them.
//
// Usage: pnpm build && pnpm test:pack
//
// It checks that:
//   1. every package packs, and npm installs the tarballs into an empty folder;
//   2. `mushin start` from that install serves the dashboard, and every built-in plugin becomes active;
//   3. tsx never loads while the instance has no TypeScript plugin;
//   4. a TypeScript plugin dropped into plugins/ loads without a build step;
//   5. create-mushin makes an app that npm and pnpm install, where `mushin new plugin` makes a plugin
//      that passes the typecheck and runs.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const TOKEN = 'pack-test-token'
const keep = process.argv.includes('--keep')

function step(text: string) {
  console.log(`\n▸ ${text}`)
}

function fail(text: string): never {
  throw new Error(text)
}

function run(command: string, args: string[], cwd: string) {
  return new Promise<string>((done, reject) => {
    // npm and pnpm are .cmd files on Windows, which only start through a shell.
    const child = spawn(command, args, { cwd, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => output += chunk)
    child.stderr.on('data', (chunk) => output += chunk)
    child.on('error', reject)
    child.on('exit', (code) => code ? reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${output}`)) : done(output))
  })
}

function freePort() {
  return new Promise<number>((done, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => done(port))
    })
  })
}

async function waitFor<T>(check: () => T | Promise<T>, what: string, timeout = 60_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value as NonNullable<T>
    } catch (error) {
      last = error
    }
    await new Promise((done) => setTimeout(done, 200))
  }
  return fail(`timed out waiting for ${what}${last ? `: ${last}` : ''}`)
}

/** Every installed copy of a package under a node_modules folder, nested ones included. */
function findPackages(nodeModules: string, name: string): string[] {
  const found: string[] = []
  if (existsSync(join(nodeModules, name, 'package.json'))) found.push(join(nodeModules, name))
  for (const entry of existsSync(nodeModules) ? readdirSync(nodeModules) : []) {
    if (entry.startsWith('.')) continue
    const dirs = entry.startsWith('@') ? readdirSync(join(nodeModules, entry)).map((sub) => join(nodeModules, entry, sub)) : [join(nodeModules, entry)]
    for (const dir of dirs) found.push(...findPackages(join(dir, 'node_modules'), name))
  }
  return found
}

// --- 1. Pack and install ---------------------------------------------------------------------------------

const packages = readdirSync(join(root, 'packages'))
  .map((dir) => ({ dir: join(root, 'packages', dir), pkg: JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) }))
  .filter(({ pkg }) => !pkg.private)

for (const { dir, pkg } of packages) {
  const built = pkg.name === '@mushinjs/dashboard' ? 'dist/index.html' : pkg.publishConfig?.exports?.['.']?.import
  if (built && !existsSync(join(dir, built))) fail(`${pkg.name} is not built (${built} is missing). Run "pnpm build" first.`)
}

const work = await mkdtemp(join(tmpdir(), 'mushin-pack-'))
const tarballs = join(work, 'tarballs')
const app = join(work, 'app')
let child: ChildProcess | undefined

try {
  step(`Packing ${packages.length} packages into ${tarballs}`)
  await mkdir(tarballs)
  const files: Record<string, string> = {}
  for (const { dir, pkg } of packages) {
    const before = new Set(readdirSync(tarballs))
    await run('pnpm', ['pack', '--pack-destination', tarballs], dir)
    const file = readdirSync(tarballs).find((name) => !before.has(name))
    if (!file) fail(`pnpm pack wrote no tarball for ${pkg.name}`)
    files[pkg.name] = join(tarballs, file)
  }

  step('Installing @mushinjs/cli from the tarballs with npm')
  await mkdir(app)
  const spec = (name: string) => `file:${files[name]!.replaceAll('\\', '/')}`
  await writeFile(join(app, 'package.json'), JSON.stringify({
    name: 'mushin-pack-test',
    private: true,
    type: 'module',
    dependencies: { '@mushinjs/cli': spec('@mushinjs/cli') },
    // Point every @mushinjs/* dependency at its tarball instead of the registry.
    overrides: Object.fromEntries(Object.keys(files).map((name) => [name, spec(name)])),
  }, null, 2))
  await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], app)

  const installed = join(app, 'node_modules', '@mushinjs')
  for (const name of readdirSync(installed)) {
    if (existsSync(join(installed, name, 'src'))) {
      const pkg = JSON.parse(readFileSync(join(installed, name, 'package.json'), 'utf8'))
      if (pkg.name !== '@mushinjs/ui') fail(`@mushinjs/${name} was published with its TypeScript sources`)
    }
  }

  // Two copies of cordis split the plugins into two worlds that cannot see each other's services.
  // npm nests a second copy when a dependency's peer range picks a newer cordis than the one we pin.
  const copies = findPackages(join(app, 'node_modules'), 'cordis')
  const versions = new Set(copies.map((dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version))
  if (versions.size > 1) fail(`npm installed more than one cordis: ${[...versions].join(', ')}\n${copies.join('\n')}`)
  console.log(`  one cordis (${[...versions][0]})`)

  // --- 2 and 3. Start without TypeScript plugins -----------------------------------------------------------

  // Records every tsx module the process loads. module.registerHooks runs in the main thread (Node 22.15+).
  const probeLog = join(work, 'tsx-loads.log')
  const probe = join(work, 'probe.mjs')
  await writeFile(probe, `
import { registerHooks } from 'node:module'
import { appendFileSync } from 'node:fs'
registerHooks({
  load(url, context, next) {
    if (url.includes('/node_modules/tsx/')) appendFileSync(${JSON.stringify(probeLog)}, url + '\\n')
    return next(url, context)
  },
})
`)
  const tsxLoads = () => existsSync(probeLog) ? readFileSync(probeLog, 'utf8').trim().split('\n') : []

  const instanceDir = join(app, 'instance')
  const bin = join(app, 'node_modules', '@mushinjs', 'cli', 'bin', 'mushin.js')

  async function startMushin(dir = instanceDir, mushinBin = bin) {
    const port = await freePort()
    let output = ''
    child = spawn(process.execPath, ['--import', pathToFileURL(probe).href, mushinBin, 'start', '--dir', dir, '--port', String(port)], {
      cwd: dir === instanceDir ? app : dir,
      env: { ...process.env, MUSHIN_ADMIN_TOKEN: TOKEN, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', (chunk) => output += chunk)
    child.stderr!.on('data', (chunk) => output += chunk)
    const exited = new Promise<never>((_, reject) => child!.once('exit', (code) => reject(new Error(`mushin exited with ${code}\n${output}`))))
    const base = `http://127.0.0.1:${port}`
    await Promise.race([exited, waitFor(() => output.includes('Mushin.js dashboard:'), 'the dashboard sign-in message')])
      .catch((error) => fail(`${error.message}\n--- mushin output ---\n${output}`))

    async function call<T = any>(action: string, input: unknown = {}): Promise<T> {
      const response = await fetch(`${base}/api/actions/${action}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      const json = await response.json() as any
      if (!json.ok) fail(`${action}: ${json.error.message}`)
      return json.result
    }

    const entries = await waitFor(async () => {
      const list = await call<{ id: string; package: string; status: string; error?: string }[]>('plugins.list')
      const failed = list.find((entry) => entry.status === 'failed')
      if (failed) fail(`${failed.package} failed to start: ${failed.error}\n--- mushin output ---\n${output}`)
      return list.every((entry) => entry.status === 'active' || entry.status === 'disabled') ? list : undefined
    }, 'every plugin to become active')

    return { base, entries, call, output: () => output }
  }

  async function stopMushin() {
    if (!child || child.exitCode !== null) return
    const exited = new Promise((done) => child!.once('exit', done))
    child.kill()
    await exited
  }

  step('Starting mushin from the install')
  {
    const { base, entries } = await startMushin()
    const page = await fetch(base)
    const html = await page.text()
    if (page.status !== 200 || !html.includes('<div id="app">')) fail(`the dashboard did not load: HTTP ${page.status}`)
    const script = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1] ?? fail('the dashboard page names no script')
    if ((await fetch(base + script)).status !== 200) fail(`the dashboard script ${script} did not load`)
    console.log(`  dashboard at ${base}, ${entries.filter((entry) => entry.status === 'active').length} plugins active`)
    if (tsxLoads().length) fail(`tsx loaded without a TypeScript plugin:\n${tsxLoads().join('\n')}`)
    console.log('  tsx did not load')
    await stopMushin()
  }

  // --- 4. A TypeScript plugin in plugins/ -----------------------------------------------------------------

  step('Adding a TypeScript plugin to plugins/ and starting again')
  const plugin = join(instanceDir, 'plugins', 'hello-ts')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'package.json'), JSON.stringify({
    name: 'mushin-plugin-hello-ts',
    version: '1.0.0',
    type: 'module',
    exports: { '.': './src/index.ts' },
    mushin: { kind: 'app' },
  }, null, 2))
  await mkdir(join(plugin, 'src'))
  // Type annotations and an import without a file extension: both need tsx, neither works in plain Node.
  await writeFile(join(plugin, 'src', 'greeting.ts'), `export const greeting: string = 'hello from a TypeScript plugin'\n`)
  await writeFile(join(plugin, 'src', 'index.ts'), `
import type { Context } from '@mushinjs/core'
import { greeting } from './greeting'

export const name = 'hello-ts'

export function apply(ctx: Context): void {
  ctx.logger('hello-ts').info(greeting)
}
`)
  const configFile = join(instanceDir, 'mushin.config.json')
  const config = JSON.parse(await readFile(configFile, 'utf8'))
  config.plugins.push({ id: 'hello-ts', package: 'mushin-plugin-hello-ts', config: {} })
  await writeFile(configFile, JSON.stringify(config, null, 2))
  {
    const { entries, output } = await startMushin()
    const entry = entries.find((item) => item.package === 'mushin-plugin-hello-ts')
    if (entry?.status !== 'active') fail(`the TypeScript plugin is ${entry?.status ?? 'missing'}`)
    await waitFor(() => output().includes('hello from a TypeScript plugin'), 'the TypeScript plugin to log', 5000)
    if (!tsxLoads().length) fail('the TypeScript plugin loaded, but not through tsx')
    console.log('  the plugin is active and loaded through tsx')
    await stopMushin()
  }

  // --- 5. An app from create-mushin, with npm and with pnpm -----------------------------------------------

  const creator = join(work, 'creator')
  await mkdir(creator)
  await writeFile(join(creator, 'package.json'), '{"private":true}')
  await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', spec('create-mushin')], creator)
  const createBin = join(creator, 'node_modules', 'create-mushin', 'bin', 'create-mushin.js')

  for (const pm of ['npm', 'pnpm'] as const) {
    step(`Creating an app with create-mushin and installing it with ${pm}`)
    const dir = join(work, `${pm}-app`)
    await run(process.execPath, [createBin, dir, '--no-install', '--pm', pm], work)
    // The app asks for the version create-mushin was built with; point those packages at the tarballs.
    const pkgFile = join(dir, 'package.json')
    const pkg = JSON.parse(await readFile(pkgFile, 'utf8'))
    for (const name of Object.keys(pkg.dependencies)) pkg.dependencies[name] = spec(name)
    const overrides = Object.fromEntries(Object.keys(files).filter((name) => name !== 'create-mushin').map((name) => [name, spec(name)]))
    if (pm === 'npm') {
      pkg.overrides = overrides
      await writeFile(pkgFile, JSON.stringify(pkg, null, 2))
      await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir)
    } else {
      await writeFile(pkgFile, JSON.stringify(pkg, null, 2))
      // Keep the settings create-mushin wrote and add the overrides.
      const settings = join(dir, 'pnpm-workspace.yaml')
      await writeFile(settings, await readFile(settings, 'utf8') + 'overrides:\n' + Object.entries(overrides).map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}\n`).join(''))
      await run('pnpm', ['install'], dir)
    }
    const appBin = join(dir, 'node_modules', '@mushinjs', 'cli', 'bin', 'mushin.js')
    await run(process.execPath, [appBin, 'new', 'plugin', 'demo-tool'], dir)
    await run(pm, ['run', 'typecheck'], dir)
    console.log('  mushin new plugin demo-tool passes the typecheck')
    const { entries, call } = await startMushin(dir, appBin)
    if (entries.find((item) => item.package === 'mushin-plugin-demo-tool')?.status !== 'active') fail(`the new plugin did not start with ${pm}`)
    const reply = await call<{ text: string }>('demoTool.hello', { name: pm })
    if (reply.text !== `Hello, ${pm}!`) fail(`demoTool.hello answered ${JSON.stringify(reply)}`)
    for (const path of ['mushin.config.json', 'data/mushin.db', 'data/layout.json', 'AGENTS.md', '.gitignore']) {
      if (!existsSync(join(dir, path))) fail(`the ${pm} app has no ${path} after starting`)
    }
    console.log(`  the app starts, the plugin answers, and the folder matches the layout`)
    await stopMushin()
  }

  console.log('\n✓ The packed packages install and run.')
} finally {
  if (child && child.exitCode === null) child.kill()
  if (keep) {
    console.log(`\nKept ${work}`)
    if (existsSync(join(app, 'node_modules'))) {
      console.log(`Start the installed copy yourself:\n  cd ${JSON.stringify(app)}\n  npx mushin start --dir instance`)
    }
  }
  else await rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
}
