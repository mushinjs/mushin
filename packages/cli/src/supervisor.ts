/**
 * `mushin start` runs the app as a child process and stays as a small supervisor, so the app can be restarted and
 * updated from the dashboard: Node cannot unload modules, and on Windows the files of a running app cannot be
 * replaced. This module loads no plugin, no tsx and not start.ts, only Node built-ins and `@mushinjs/core/system`,
 * so the packages it installs are never in use by it.
 *
 * An update: the app writes `<data>/.upgrade/plan.json`, backs up package.json and the lock file, and sends
 * `update`. The supervisor stops the app, installs, runs the new version's `migrate` and `skills`, starts it and
 * waits for `ready`. If the install fails, the new version never gets ready, or it crashes soon after, everything
 * goes back: package.json and the lock file, the installed packages, and the data folder when the new version moved
 * it. Either way `<data>/.upgrade/result.json` says how it went.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { copyFile, cp, readdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import {
  appPackageManager, type ChildMessage, installCommand, uninstallCommand, readJsonFile, readLines, reinstallCommand, run, SUPERVISOR_ENV,
  supervisorPath, type UpgradePlan, type UpgradeResult, writeJsonFile, writeLine,
} from '@mushinjs/core/system'

/** Runs a command, sending its output to `output`; rejects when it fails. Tests pass a fake one. */
export type Runner = (command: string, args: readonly string[], cwd: string, output: (chunk: string) => void) => Promise<void>

/** A running app, as the supervisor sees it. */
export interface AppProcess {
  /** Resolves with the exit code when it stops (1 when a signal killed it). */
  exited: Promise<number>
  kill(): void
}

export interface SupervisorOptions {
  baseDir: string
  /** Starts the app with the pipe path in its environment. */
  launch: (env: Record<string, string>) => AppProcess
  runner?: Runner
  /** Where the line to the app goes; a fresh one by default. */
  path?: string
  readyTimeout?: number
  /** A crash this soon after `ready` counts as a failed update. */
  crashWindow?: number
  /** How long the app gets to stop before it is killed. */
  stopTimeout?: number
  print?: (line: string) => void
}

const defaultRunner: Runner = (command, args, cwd, output) => run(command, args, cwd, { output })

const sleep = (ms: number) => new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms).unref())

interface Running {
  app: AppProcess
  exited: Promise<number>
  ready: Promise<void>
  socket?: Socket
  markReady: () => void
}

type Request = { type: 'restart' } | { type: 'update'; packages: string[]; dir: string }

export class Supervisor {
  readonly path: string
  private server?: Server
  private current?: Running
  private request?: Request
  private closing = false
  private readonly runner: Runner
  private readonly print: (line: string) => void

  constructor(private options: SupervisorOptions) {
    this.path = options.path ?? supervisorPath()
    this.runner = options.runner ?? defaultRunner
    this.print = options.print ?? ((line) => console.log(line))
  }

  private listen() {
    return new Promise<void>((resolve, reject) => {
      this.server = createServer((socket) => {
        // The newest connection is the app that runs now.
        const running = this.current
        if (running) running.socket = socket
        socket.on('error', () => {})
        readLines(socket, (message: ChildMessage) => this.onMessage(running, message))
      })
      this.server.on('error', reject)
      this.server.listen(this.path, () => resolve())
    })
  }

  private onMessage(running: Running | undefined, message: ChildMessage) {
    if (!running || running !== this.current) return
    if (message.type === 'ready') running.markReady()
    else if ((message.type === 'restart' || message.type === 'update') && !this.request && !this.closing) {
      this.request = message.type === 'update' ? { type: 'update', packages: message.packages, dir: message.dir } : { type: 'restart' }
      void this.stop(running)
    }
  }

  private launch(): Running {
    let markReady!: () => void
    const ready = new Promise<void>((resolve) => (markReady = resolve))
    const app = this.options.launch({ [SUPERVISOR_ENV]: this.path })
    const running: Running = { app, exited: app.exited, ready, markReady }
    this.current = running
    return running
  }

  /** Asks the app to stop, and kills it if it has not after a while. */
  private async stop(running: Running) {
    if (running.socket && !running.socket.destroyed) writeLine(running.socket, { type: 'shutdown' })
    else running.app.kill()
    const result = await Promise.race([running.exited, sleep(this.options.stopTimeout ?? 20_000)])
    if (result === 'timeout') running.app.kill()
    await running.exited
  }

  /** Ctrl+C: the app stops (a second one kills it), then the supervisor exits with its code. */
  interrupt() {
    if (this.closing) {
      this.current?.app.kill()
      return
    }
    this.closing = true
    if (this.current) void this.stop(this.current)
  }

  /** Runs the app until it stops on its own or is stopped; resolves with the exit code for this process. */
  async run(): Promise<number> {
    await this.listen()
    let running = this.launch()
    try {
      for (;;) {
        const code = await running.exited
        const request = this.request
        this.request = undefined
        if (this.closing) return code
        // An app that stops by itself is not started again: a crash loop helps nobody.
        if (!request) return code
        if (request.type === 'restart') {
          this.print('Restarting Mushin.js…')
          running = this.launch()
          continue
        }
        running = await this.update(request)
      }
    } finally {
      this.server?.close()
    }
  }

  /** Waits for `ready`; false when the app exits first or takes too long. */
  private async waitReady(running: Running) {
    const result = await Promise.race([
      running.ready.then(() => 'ready' as const),
      running.exited.then(() => 'exited' as const),
      sleep(this.options.readyTimeout ?? 60_000),
    ])
    return result
  }

  private async update(request: Extract<Request, { type: 'update' }>): Promise<Running> {
    const { baseDir } = this.options
    const plan = await readJsonFile<UpgradePlan>(join(request.dir, 'plan.json'))
    const packages = plan?.packages ?? request.packages
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const logsDir = plan?.logsDir ?? join(baseDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    const log = join(logsDir, `upgrade-${stamp}.log`)
    const write = (text: string) => {
      try {
        appendFileSync(log, text)
      } catch {}
    }
    const say = (line: string) => {
      this.print(line)
      write(`[${new Date().toISOString()}] ${line}\n`)
    }
    const remove = plan?.remove ?? []
    const result: UpgradeResult = { ok: false, kind: plan?.kind ?? 'update', from: plan?.from ?? '?', to: plan?.to, packages, ...(remove.length ? { remove } : {}), log, time: Date.now() }
    const pm = appPackageManager(baseDir)
    const backupsBefore = plan?.dataDir ? await listDir(join(plan.dataDir, 'backups')) : []
    const exec = (command: string, args: readonly string[]) => {
      say(`$ ${command} ${args.join(' ')}`)
      return this.runner(command, args, baseDir, write)
    }

    say(`${{ update: 'Updating', install: 'Installing', uninstall: 'Uninstalling' }[result.kind!]}: ${[...packages, ...remove.map((name) => `-${name}`)].join(', ')}`)
    let failure: string | undefined
    let running: Running | undefined
    try {
      if (remove.length) {
        const [command, args] = uninstallCommand(pm, remove)
        await exec(command, args)
      }
      if (packages.length) {
        const [command, args] = installCommand(pm, packages)
        await exec(command, args)
      }
      // The new version decides the data layout and the skills, so its own CLI does them.
      const bin = join(baseDir, 'node_modules', '@mushinjs', 'cli', 'bin', 'mushin.js')
      if (existsSync(bin)) {
        await exec(process.execPath, [bin, 'migrate', '--dir', baseDir])
        await exec(process.execPath, [bin, 'skills', '--dir', baseDir]).catch((error) => say(`skills: ${(error as Error).message}`))
      }
      say('Starting the new version…')
      running = this.launch()
      const state = await this.waitReady(running)
      if (state === 'exited') throw new Error(`the new version stopped with code ${await running.exited} before it was ready`)
      if (state === 'timeout') throw new Error(`the new version was not ready after ${Math.round((this.options.readyTimeout ?? 60_000) / 1000)} s`)
      result.ok = true
      result.version = plan?.to
      await writeJsonFile(join(request.dir, 'result.json'), result)
      say('The new version is up.')
      const after = await Promise.race([running.exited.then(() => 'exited' as const), sleep(this.options.crashWindow ?? 30_000)])
      if (after === 'exited' && !this.closing && !this.request) throw new Error(`the new version stopped with code ${await running.exited} right after it started`)
      return running
    } catch (error) {
      failure = (error as Error).message
    }

    say(`The ${result.kind} failed: ${failure}. Going back to how it was (${result.from}).`)
    if (running) await this.stop(running)
    try {
      const backup = join(request.dir, 'backup')
      for (const name of ['package.json', 'package-lock.json', 'pnpm-lock.yaml']) {
        if (existsSync(join(backup, name))) await copyFile(join(backup, name), join(baseDir, name))
      }
      const [command, args] = reinstallCommand(pm)
      await exec(command, args)
      if (plan?.dataDir) await restoreData(plan.dataDir, backupsBefore, say)
    } catch (error) {
      say(`Going back failed too: ${(error as Error).message}`)
    }
    result.ok = false
    result.error = failure
    result.version = result.from
    await writeJsonFile(join(request.dir, 'result.json'), result)
    return this.launch()
  }
}

async function listDir(dir: string) {
  return readdir(dir).catch(() => [] as string[])
}

/**
 * Puts the data folder back when the new version moved it to a newer layout: start leaves a copy in
 * `data/backups/<time>-layout-<n>/` before it moves anything.
 */
async function restoreData(dataDir: string, before: string[], say: (line: string) => void) {
  const added = (await listDir(join(dataDir, 'backups'))).filter((name) => !before.includes(name) && /-layout-/.test(name)).sort()
  const copy = added[0]
  if (!copy) return
  const from = join(dataDir, 'backups', copy)
  say(`Restoring the data folder from ${from}`)
  for (const name of await listDir(dataDir)) {
    if (name === 'backups' || name === '.upgrade') continue
    await rm(join(dataDir, name), { recursive: true, force: true })
  }
  for (const name of await listDir(from)) await cp(join(from, name), join(dataDir, name), { recursive: true })
}

/** The app as a child process: this same command, with `--no-supervisor` implied by the environment. */
export function launchApp(script: string, args: string[]) {
  return (env: Record<string, string>): AppProcess => {
    const child: ChildProcess = spawn(process.execPath, [...process.execArgv, script, ...args], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    })
    const exited = new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? 1))
      child.on('error', () => resolve(1))
    })
    return { exited, kill: () => child.kill() }
  }
}

/** `mushin start` under a supervisor; called by bin/mushin.js before anything else loads. */
export async function supervise(script: string, args: string[]) {
  const dirIndex = args.findIndex((arg) => arg === '--dir' || arg === '-d')
  let baseDir = dirIndex >= 0 ? args[dirIndex + 1]! : process.cwd()
  if (dirIndex < 0 && !existsSync('mushin.config.json') && existsSync(join('instance', 'mushin.config.json'))) baseDir = 'instance'
  const supervisor = new Supervisor({ baseDir: resolve(baseDir), launch: launchApp(script, args) })
  process.on('SIGINT', () => supervisor.interrupt())
  process.on('SIGTERM', () => supervisor.interrupt())
  process.exit(await supervisor.run())
}
