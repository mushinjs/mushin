import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readLines, SUPERVISOR_ENV, SupervisorLink, supervisorPath, type UpgradePlan, type UpgradeResult, writeLine } from '@mushinjs/core/system'
import { type AppProcess, type Runner, Supervisor } from '../src/supervisor'

/** How a fake app behaves: whether it says ready, and whether it stops soon after. */
interface Behaviour {
  ready?: boolean
  /** Stops by itself with this code, this many ms after starting. */
  exit?: { code: number; after: number }
}

/** Apps that connect to the supervisor like the real one, started in this process. */
function fakeApps(behaviours: Behaviour[]) {
  const started: { socket: Socket; stop: (code: number) => void; exited: Promise<number> }[] = []
  const launch = (env: Record<string, string>): AppProcess => {
    const behaviour = behaviours[started.length] ?? { ready: true }
    let stop!: (code: number) => void
    const exited = new Promise<number>((resolve) => (stop = resolve))
    const socket = connect(env[SUPERVISOR_ENV]!, () => {
      if (behaviour.ready !== false) writeLine(socket, { type: 'ready' })
    })
    socket.on('error', () => {})
    readLines(socket, (message) => {
      if (message.type === 'shutdown') stop(0)
    })
    if (behaviour.exit) setTimeout(() => stop(behaviour.exit!.code), behaviour.exit.after)
    void exited.then(() => socket.destroy())
    started.push({ socket, stop, exited })
    return { exited, kill: () => stop(1) }
  }
  return { launch, started }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

/** An app folder with a plan for an update, as plugins.applyUpdates writes it. */
async function appWithPlan() {
  const baseDir = await mkdtemp(join(tmpdir(), 'mushin-supervisor-'))
  const dataDir = join(baseDir, 'data')
  const dir = join(dataDir, '.upgrade')
  await mkdir(join(dir, 'backup'), { recursive: true })
  await writeFile(join(baseDir, 'package.json'), '{"dependencies":{"@mushinjs/cli":"0.3.0"}}')
  await writeFile(join(baseDir, 'package-lock.json'), '{"lock":"old"}')
  await writeFile(join(dir, 'backup', 'package.json'), '{"dependencies":{"@mushinjs/cli":"0.3.0"}}')
  await writeFile(join(dir, 'backup', 'package-lock.json'), '{"lock":"old"}')
  await writeFile(join(dataDir, 'bots.json'), 'old layout')
  const plan: UpgradePlan = { packages: ['@mushinjs/cli@0.4.0'], from: '0.3.0', to: '0.4.0', time: 1, dataDir, logsDir: join(baseDir, 'logs') }
  await writeFile(join(dir, 'plan.json'), JSON.stringify(plan))
  return { baseDir, dataDir, dir }
}

/** An install that rewrites package.json, and a new version whose start moves the data folder (keeping a copy). */
function installer(baseDir: string, dataDir: string, options: { fail?: boolean } = {}) {
  const commands: string[] = []
  const runner: Runner = async (command, args, _cwd, output) => {
    commands.push(`${command} ${args.join(' ')}`)
    output(`ran ${command}\n`)
    if (args[0] === 'install' && args.length > 1) {
      if (options.fail) throw new Error('npm install exited with 1')
      await writeFile(join(baseDir, 'package.json'), '{"dependencies":{"@mushinjs/cli":"0.4.0"}}')
      await writeFile(join(baseDir, 'package-lock.json'), '{"lock":"new"}')
      await mkdir(join(dataDir, 'backups', '20261126-layout-1'), { recursive: true })
      await writeFile(join(dataDir, 'backups', '20261126-layout-1', 'bots.json'), 'old layout')
      await mkdir(join(dataDir, 'bots'), { recursive: true })
      await writeFile(join(dataDir, 'bots', 'index.json'), 'new layout')
      await writeFile(join(dataDir, 'bots.json'), '')
    }
  }
  return { runner, commands }
}

const quiet = () => {}

describe('the supervisor', () => {
  it('exits with the code of an app that stops by itself, without starting it again', async () => {
    const apps = fakeApps([{ exit: { code: 3, after: 50 } }])
    const supervisor = new Supervisor({ baseDir: tmpdir(), launch: apps.launch, print: quiet })
    expect(await supervisor.run()).toBe(3)
    expect(apps.started).toHaveLength(1)
  })

  it('restarts the app when it asks, and stops it on Ctrl+C', async () => {
    const apps = fakeApps([{}, {}])
    const supervisor = new Supervisor({ baseDir: tmpdir(), launch: apps.launch, print: quiet })
    const done = supervisor.run()
    await until(() => apps.started.length === 1)
    writeLine(apps.started[0]!.socket, { type: 'restart' })
    await until(() => apps.started.length === 2)
    expect(await apps.started[0]!.exited).toBe(0)
    supervisor.interrupt()
    expect(await done).toBe(0)
  })

  it('updates: stops the app, installs, migrates with the new version, starts it and says it worked', async () => {
    const { baseDir, dataDir, dir } = await appWithPlan()
    const { runner, commands } = installer(baseDir, dataDir)
    const apps = fakeApps([{}, {}])
    const supervisor = new Supervisor({ baseDir, launch: apps.launch, runner, print: quiet, crashWindow: 100 })
    const done = supervisor.run()
    await until(() => apps.started.length === 1)
    writeLine(apps.started[0]!.socket, { type: 'update', packages: ['@mushinjs/cli@0.4.0'], dir })
    await until(() => existsSync(join(dir, 'result.json')))
    const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as UpgradeResult
    expect(result).toMatchObject({ ok: true, from: '0.3.0', to: '0.4.0', version: '0.4.0', packages: ['@mushinjs/cli@0.4.0'] })
    expect(commands).toEqual(['npm install --save-exact @mushinjs/cli@0.4.0'])
    expect(await readFile(result.log!, 'utf8')).toContain('ran npm')
    expect(apps.started).toHaveLength(2)
    supervisor.interrupt()
    expect(await done).toBe(0)
  })

  it('goes back when the new version does not start: package.json, lock file, packages and data', async () => {
    const { baseDir, dataDir, dir } = await appWithPlan()
    const { runner, commands } = installer(baseDir, dataDir)
    // The old app, the new one that crashes before it is ready, then the old one again.
    const apps = fakeApps([{}, { ready: false, exit: { code: 1, after: 50 } }, {}])
    const supervisor = new Supervisor({ baseDir, launch: apps.launch, runner, print: quiet })
    const done = supervisor.run()
    await until(() => apps.started.length === 1)
    writeLine(apps.started[0]!.socket, { type: 'update', packages: ['@mushinjs/cli@0.4.0'], dir })
    await until(() => apps.started.length === 3)
    const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as UpgradeResult
    expect(result).toMatchObject({ ok: false, from: '0.3.0', to: '0.4.0', version: '0.3.0', error: expect.stringContaining('before it was ready') })
    expect(commands).toEqual(['npm install --save-exact @mushinjs/cli@0.4.0', 'npm install'])
    expect(await readFile(join(baseDir, 'package.json'), 'utf8')).toContain('0.3.0')
    expect(await readFile(join(baseDir, 'package-lock.json'), 'utf8')).toBe('{"lock":"old"}')
    expect(await readFile(join(dataDir, 'bots.json'), 'utf8')).toBe('old layout')
    expect(existsSync(join(dataDir, 'bots'))).toBe(false)
    supervisor.interrupt()
    expect(await done).toBe(0)
  })

  it('goes back when the install fails, and when the new version crashes right after it is up', async () => {
    const first = await appWithPlan()
    const failing = installer(first.baseDir, first.dataDir, { fail: true })
    const apps = fakeApps([{}, {}])
    const supervisor = new Supervisor({ baseDir: first.baseDir, launch: apps.launch, runner: failing.runner, print: quiet })
    const done = supervisor.run()
    await until(() => apps.started.length === 1)
    writeLine(apps.started[0]!.socket, { type: 'update', packages: ['@mushinjs/cli@0.4.0'], dir: first.dir })
    await until(() => apps.started.length === 2)
    expect(JSON.parse(await readFile(join(first.dir, 'result.json'), 'utf8'))).toMatchObject({ ok: false, error: 'npm install exited with 1' })
    supervisor.interrupt()
    await done

    const second = await appWithPlan()
    const crashing = installer(second.baseDir, second.dataDir)
    const apps2 = fakeApps([{}, { exit: { code: 1, after: 80 } }, {}])
    const supervisor2 = new Supervisor({ baseDir: second.baseDir, launch: apps2.launch, runner: crashing.runner, print: quiet, crashWindow: 1000 })
    const done2 = supervisor2.run()
    await until(() => apps2.started.length === 1)
    writeLine(apps2.started[0]!.socket, { type: 'update', packages: ['@mushinjs/cli@0.4.0'], dir: second.dir })
    await until(() => apps2.started.length === 3)
    expect(JSON.parse(await readFile(join(second.dir, 'result.json'), 'utf8'))).toMatchObject({ ok: false, error: expect.stringContaining('right after it started') })
    supervisor2.interrupt()
    await done2
  })
})

describe("the app's end of the line", () => {
  it('sends messages, and stops the app once when asked or when the supervisor goes away', async () => {
    const path = supervisorPath()
    const received: unknown[] = []
    let peer!: Socket
    const server = createServer((socket) => {
      peer = socket
      readLines(socket, (message) => received.push(message))
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    const link = new SupervisorLink(path)
    let stops = 0
    link.on('shutdown', () => stops++)
    await link.send({ type: 'ready', version: '1.0.0' })
    await until(() => received.length === 1)
    expect(received[0]).toEqual({ type: 'ready', version: '1.0.0' })
    writeLine(peer, { type: 'shutdown' })
    await until(() => stops === 1)
    peer.destroy()
    server.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(stops).toBe(1)

    // A supervisor killed without a word.
    const path2 = supervisorPath()
    let peer2!: Socket
    const server2 = createServer((socket) => (peer2 = socket))
    await new Promise<void>((resolve) => server2.listen(path2, resolve))
    const orphan = new SupervisorLink(path2)
    let orphaned = false
    orphan.on('shutdown', () => (orphaned = true))
    await orphan.send({ type: 'ready' })
    peer2.destroy()
    server2.close()
    await until(() => orphaned)
  })
})
