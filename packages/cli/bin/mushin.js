#!/usr/bin/env node
// A published install runs the compiled dist/. Inside the repository there is no dist/ until a build,
// and the TypeScript sources run through tsx, so a change shows up without building.
//
// `mushin start` stays as a small supervisor that runs the app as a child process, so the dashboard can restart
// and update it; `--no-supervisor` keeps one process. The child (MUSHIN_SUPERVISOR is set) runs the app itself.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = new URL('../src/cli.ts', import.meta.url)
const fromSource = existsSync(source)
if (fromSource) {
  const { register } = await import('tsx/esm/api')
  register()
}

const args = process.argv.slice(2)
const single = args.includes('--no-supervisor')
if (single) process.argv.splice(process.argv.indexOf('--no-supervisor'), 1)
const command = args.find((arg, index) => !arg.startsWith('-') && !['-d', '--dir', '-p', '--port'].includes(args[index - 1])) ?? 'start'

if (command === 'start' && !single && !args.includes('-h') && !args.includes('--help') && !process.env.MUSHIN_SUPERVISOR) {
  const { supervise } = await import(fromSource ? new URL('../src/supervisor.ts', import.meta.url).href : '../dist/supervisor.js')
  await supervise(fileURLToPath(import.meta.url), process.argv.slice(2))
} else {
  await import(fromSource ? source.href : '../dist/cli.js')
}
