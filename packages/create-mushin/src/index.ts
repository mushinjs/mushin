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
    'AGENTS.md': agentsGuide(name),
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

function agentsGuide(name: string) {
  return `# ${name}

This folder is a [Mushin.js](https://github.com/mushinjs/mushin) app: a chatbot framework for QQ (through OneBot / NapCat) with LLM chat, conversation flows and a Fairy. Read this before changing anything here.

## Commands

- \`npm start\` starts Mushin.js and prints the dashboard sign-in link (\`pnpm start\` with pnpm).
- \`npm run upgrade\` updates every \`@mushinjs/*\` package and moves the data to the new version's layout. Stop Mushin.js first.
- \`npx mushin new plugin <name>\` creates a TypeScript plugin in \`plugins/<name>/\` and turns it on.
- \`npm run typecheck\` checks the plugins in \`plugins/\`.
- \`npx mushin token reset\` makes a new admin token for the dashboard.

## Managing Mushin.js from an AI tool

\`.mcp.json\` connects the AI tool you open in this folder (Claude Code and others that read it) to the running Mushin.js through \`mushin mcp\`. Start Mushin.js first. The tools are Mushin.js actions: list bots, read logs, build and test flows, and more. Dangerous ones wait for approval in the dashboard. The admin token is read from \`.env\`; do not copy it anywhere.

## Skills

\`.claude/skills/\` holds the official skills. Read the matching \`SKILL.md\` before you start one of these jobs, whichever AI tool you are:

- \`mushin-plugin-dev\`: writing or changing a plugin in \`plugins/\`. It starts with the questions to ask the user first.
- \`mushin-flows\`: building and testing conversation flows.
- \`mushin-troubleshoot\`: finding out why a bot, command, flow or plugin does not work.
- \`mushin-operations\`: upgrades, backups, restores, moving machines, the admin token.

\`npm run upgrade\` replaces them with the new version's; put your own skills in other folders.

## Layout

| Path | What it is | Who writes it |
| --- | --- | --- |
| \`mushin.config.json\` | Which plugins run, and their settings. Holds no secrets. | People, the dashboard, Fairy |
| \`.mcp.json\` | Connects the AI tool opened here to Mushin.js. Holds no secrets. | create-mushin |
| \`.claude/skills/\` | The official skills for AI tools | Mushin.js (on create and upgrade) |
| \`.env\` | Secrets: the admin token, provider keys, bot tokens. Configuration refers to them as \`\${NAME}\`. | Mushin.js and people |
| \`plugins/\` | Local plugins, run as TypeScript without a build step | People and AIs |
| \`skills/\` | Your own skills, one folder each with a \`SKILL.md\` | People and AIs |
| \`data/\` | Everything Mushin.js keeps: database, bots, providers, flows, message logs. Back up this folder. | Mushin.js only |
| \`cache/\`, \`logs/\` | Safe to delete | Mushin.js only |

## Rules

- Do not edit files under \`data/\` by hand while Mushin.js runs. Change things through the dashboard or its actions.
- Never print, commit or copy the contents of \`.env\`. To use a secret in a setting, write \`\${NAME}\` and put \`NAME=value\` in \`.env\`.
- A plugin is a package in \`plugins/<name>/\` with a \`mushin\` field in its \`package.json\`. It exports \`name\`, optionally \`inject\` and \`Config\` (a zod schema), and \`apply(ctx, config)\`. Import everything from \`@mushinjs/core\`.
- After changing a plugin, reload it from the dashboard's Plugins page or restart Mushin.js.
`
}

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

/** Puts the official skills into the app, with the CLI that was just installed. */
export function addSkills(dir: string) {
  return new Promise<void>((done, reject) => {
    const bin = join(dir, 'node_modules', '@mushinjs', 'cli', 'bin', 'mushin.js')
    const child = spawn(process.execPath, [bin, 'skills', '--dir', dir], { cwd: dir, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code ? reject(new Error(`mushin skills exited with ${code}`)) : done()))
  })
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
