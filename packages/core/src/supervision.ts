/**
 * The line between `mushin start` (the supervisor) and the app it runs as a child process. Node cannot unload
 * modules, so a new version needs a new process, and on Windows the files a running app holds cannot be replaced:
 * the supervisor stops the app, installs, and starts it again. They talk over a named pipe (Windows) or a Unix
 * socket, one JSON object per line; the path is in the MUSHIN_SUPERVISOR environment variable of the child.
 * Node built-ins only, like packages.ts.
 */
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SUPERVISOR_ENV = 'MUSHIN_SUPERVISOR'

/** From the app to the supervisor. */
export type ChildMessage =
  /** The web server listens: the app is up. */
  | { type: 'ready'; version?: string }
  /** Stop and start again, same version. */
  | { type: 'restart' }
  /** Stop, install these (`name@version`), start the new version; the plan is in `<dir>/plan.json`. */
  | { type: 'update'; packages: string[]; dir: string }

/** From the supervisor to the app. */
export type SupervisorMessage = { type: 'shutdown' }

/** A fresh pipe or socket path for one supervisor. */
export function supervisorPath() {
  const id = `mushin-${process.pid}-${randomBytes(4).toString('hex')}`
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`)
}

/** Reads JSON lines from a socket. Lines that do not parse are dropped. */
export function readLines(socket: Socket, onMessage: (message: any) => void) {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      try {
        onMessage(JSON.parse(line))
      } catch {}
    }
  })
}

export const writeLine = (socket: Socket, message: unknown) => socket.write(JSON.stringify(message) + '\n')

/** The app's end of the line. */
export class SupervisorLink extends EventEmitter<{ shutdown: [] }> {
  private socket?: Socket
  private ready: Promise<void>

  constructor(readonly path: string) {
    super()
    this.ready = new Promise((resolve, reject) => {
      const socket = connect(path, () => resolve())
      socket.on('error', reject)
      // The supervisor going away must not keep the app alive or crash it.
      socket.unref()
      readLines(socket, (message: SupervisorMessage) => {
        if (message?.type === 'shutdown') this.stop()
      })
      // A supervisor that is gone (killed, its window closed) leaves nobody to stop this app: it stops too.
      socket.on('close', () => this.stop())
      this.socket = socket
    })
    this.ready.catch(() => {})
  }

  private stopped = false

  private stop() {
    if (this.stopped) return
    this.stopped = true
    this.emit('shutdown')
  }

  async send(message: ChildMessage) {
    await this.ready
    await new Promise<void>((resolve, reject) => this.socket!.write(JSON.stringify(message) + '\n', (error) => (error ? reject(error) : resolve())))
  }
}

let link: SupervisorLink | null | undefined

/** The link to the supervisor when this process runs under one, else undefined. One per process. */
export function supervisor(): SupervisorLink | undefined {
  if (link === undefined) {
    const path = process.env[SUPERVISOR_ENV]
    link = path ? new SupervisorLink(path) : null
  }
  return link ?? undefined
}
