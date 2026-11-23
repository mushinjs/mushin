import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `pnpm dev`: runs the development instance under `tsx watch`, so a change to Mushin.js restarts it. Changes in plugin
 * folders do not: tsx would restart the whole server (and stop Fairy mid-task) when a plugin file is saved, while
 * `plugins.reload` already runs the new code. The folders are read from the instance's config at launch.
 */
const cli = fileURLToPath(new URL('..', import.meta.url))
const instance = resolve(cli, '../../instance')

function pluginDirs() {
  try {
    const config = JSON.parse(readFileSync(join(instance, 'mushin.config.json'), 'utf8')) as { pluginDirs?: string[] }
    return (config.pluginDirs ?? []).filter(Boolean).map((dir) => resolve(instance, dir.replace(/^~(?=$|[\\/])/, homedir())))
  } catch {
    return []
  }
}

const excludes = [resolve(cli, '../dashboard'), join(instance, 'plugins'), ...pluginDirs()]
const tsx = createRequire(import.meta.url).resolve('tsx/cli')
const args = [
  tsx, 'watch', '--clear-screen=false',
  ...excludes.flatMap((dir) => ['--exclude', `${dir.replace(/\\/g, '/')}/**`]),
  join(cli, 'src/dev.ts'), 'start', '--dir', instance,
]
const child = spawn(process.execPath, args, { cwd: cli, stdio: 'inherit' })
// Ctrl+C reaches both through the terminal; tsx watch stops its child and exits.
process.on('SIGINT', () => {})
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
