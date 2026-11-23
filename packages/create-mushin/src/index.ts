import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/** The version of this package, which every `@mushinjs/*` package shares. */
export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

export type PackageManager = 'npm' | 'pnpm'

/** The package manager that ran `npm create` / `pnpm create`, from the user agent it sets. */
export function detectPackageManager(userAgent = process.env.npm_config_user_agent ?? ''): PackageManager {
  return userAgent.startsWith('pnpm') ? 'pnpm' : 'npm'
}

/** The version range the app depends on: a preview is pinned exactly, a release takes compatible updates. */
export function dependencyRange(version = VERSION) {
  return version.includes('-') ? version : `^${version}`
}

/** A package name made from a folder name: `My Bot` gives `my-bot`. */
export function packageName(dir: string) {
  const name = basename(resolve(dir)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|-+$/g, '')
  return name || 'mushin-app'
}

/** The files of a new app, by path relative to its folder. */
export function appFiles(name: string, version = VERSION, packageManager: PackageManager = 'npm'): Record<string, string> {
  const range = dependencyRange(version)
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
  return {
    'package.json': json({
      name,
      private: true,
      type: 'module',
      scripts: {
        start: 'mushin start',
        upgrade: 'mushin upgrade',
        typecheck: 'tsc',
      },
      dependencies: {
        '@mushinjs/cli': range,
        // Local plugins in plugins/ import it; with pnpm they only see the app's own dependencies.
        '@mushinjs/core': range,
      },
      devDependencies: {
        '@types/node': '^22.13.0',
        typescript: '^6.0.3',
      },
      engines: { node: '>=22.13' },
    }),
    'tsconfig.json': json({
      compilerOptions: {
        target: 'es2023',
        lib: ['es2023'],
        module: 'preserve',
        moduleResolution: 'bundler',
        types: ['node'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        isolatedModules: true,
        verbatimModuleSyntax: true,
      },
      include: ['plugins/*/src'],
    }),
    '.gitignore': [
      'node_modules/',
      '# Secrets: keys, tokens. Never commit or share this file.',
      '.env',
      '# Written by Mushin.js. Back up data/; cache/ and logs/ can be deleted.',
      'data/',
      'cache/',
      'logs/',
      '',
    ].join('\n'),
    // Connects the AI tool opened in this folder to the running Mushin.js; the token stays in .env.
    '.mcp.json': json({
      mcpServers: {
        mushin: { type: 'stdio', command: 'node', args: ['node_modules/@mushinjs/cli/bin/mushin.js', 'mcp'] },
      },
    }),
    'plugins/.gitkeep': '',
    'skills/.gitkeep': '',
    ...(packageManager === 'pnpm' ? { 'pnpm-workspace.yaml': PNPM_SETTINGS } : {}),
  }
}

/**
 * pnpm runs no install scripts it was not told about, and stops the install over them. esbuild (through tsx,
 * for TypeScript plugins) needs its script; ssh2 (the terminal plugin) works without its optional native parts.
 */
const PNPM_SETTINGS = `allowBuilds:
  esbuild: true
  cpu-features: false
  ssh2: false
`

/** Writes a new app into `dir`, which must be missing or empty. */
export async function createApp(dir: string, options: { version?: string; packageManager?: PackageManager } = {}) {
  const target = resolve(dir)
  const existing = await readdir(target).catch(() => [] as string[])
  if (existing.length) throw new Error(`${target} is not empty. Choose a new folder name.`)
  const files = appFiles(packageName(target), options.version, options.packageManager)
  for (const [path, content] of Object.entries(files)) {
    const file = join(target, path)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, content)
  }
  return { dir: target, files: Object.keys(files) }
}

/** Runs the CLI that was just installed in the app. */
function mushin(dir: string, args: string[]) {
  return new Promise<void>((done, reject) => {
    const bin = join(dir, 'node_modules', '@mushinjs', 'cli', 'bin', 'mushin.js')
    const child = spawn(process.execPath, [bin, ...args, '--dir', dir], { cwd: dir, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code ? reject(new Error(`mushin ${args[0]} exited with ${code}`)) : done()))
  })
}

/** Puts the official skills into the app. */
export function addSkills(dir: string) {
  return mushin(dir, ['skills'])
}

/**
 * Writes the guide for coding agents (AGENTS.md, CLAUDE.md and the like). Without `files` the CLI asks which
 * ones in a terminal, and picks AGENTS.md and CLAUDE.md otherwise.
 */
export function addAgentFiles(dir: string, files?: string) {
  return mushin(dir, files === undefined ? ['agents'] : ['agents', '--files', files])
}

/** Runs the package manager's install in the app folder, with its output shown. */
export function install(dir: string, packageManager: PackageManager) {
  return new Promise<void>((done, reject) => {
    // npm and pnpm are .cmd files on Windows, which only start through a shell.
    const child = spawn(packageManager, ['install'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', reject)
    child.on('exit', (code) => (code ? reject(new Error(`${packageManager} install exited with ${code}`)) : done()))
  })
}
