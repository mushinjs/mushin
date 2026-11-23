import { type ChildProcess, spawn } from 'node:child_process'
import { killTree, type LocalShell, shellCommand } from './shell'

/** A command started on this machine for Fairy or from the dashboard, as lists show it. */
export interface ProcessInfo {
  id: string
  command: string
  cwd: string
  startedAt: number
  endedAt?: number
  /** Exit code; null when it was stopped or could not start. */
  code?: number | null
  running: boolean
  /** Why it could not start or how it was stopped. */
  error?: string
  /** The Fairy conversation that started it. */
  session?: string
  /** Output length so far, in characters; read from an offset with `output`. */
  size: number
}

export interface ProcessOutput {
  /** Output after `since` (stdout and stderr together, in the order they came). */
  text: string
  /** Pass as `since` to read only what comes next. */
  next: number
  /** Output older than `since` was dropped to keep the buffer small; it starts here. */
  from: number
  running: boolean
  code?: number | null
  error?: string
}

interface Entry {
  info: ProcessInfo
  child?: ChildProcess
  /** The last `keep` characters of output, starting at `start`. */
  text: string
  start: number
  waiters: Set<() => void>
}

export interface ProcessEvents {
  /** A process started, ended or was forgotten (`removed`). */
  changed(info: ProcessInfo & { removed?: boolean }): void
  /** New output, in batches; `at` is where it starts in the whole output, as `size` counts it. */
  output(id: string, text: string, at: number): void
}

/**
 * Commands that keep running: dev servers, watchers, installs. Each keeps the tail of its output so it can be read
 * from an offset; finished ones stay listed until there are more than `history` of them.
 */
export class Processes {
  private entries = new Map<string, Entry>()
  private seq = 0
  private pending = new Map<string, { at: number; text: string }>()
  private flushTimer?: ReturnType<typeof setTimeout>

  constructor(private events: ProcessEvents, private options: { keep: number; history: number } = { keep: 256 * 1024, history: 30 }) {}

  start(command: string, options: { shell: LocalShell; cwd: string; env?: NodeJS.ProcessEnv; session?: string }): ProcessInfo {
    const id = `p${Date.now().toString(36)}${(++this.seq).toString(36)}`
    const info: ProcessInfo = { id, command, cwd: options.cwd, startedAt: Date.now(), running: true, size: 0, ...(options.session ? { session: options.session } : {}) }
    const entry: Entry = { info, text: '', start: 0, waiters: new Set() }
    this.entries.set(id, entry)
    this.prune()
    const { program, args, verbatim } = shellCommand(options.shell, command)
    try {
      entry.child = spawn(program, args, {
        cwd: options.cwd,
        env: { ...(options.env ?? process.env), FORCE_COLOR: '1' },
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        // Its own process group, so stopping it ends everything it started.
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      this.finish(entry, null, `Cannot start ${program}: ${(error as Error).message}`)
      return { ...info }
    }
    const child = entry.child
    const decoder = { out: new TextDecoder(), err: new TextDecoder() }
    child.stdout?.on('data', (chunk: Buffer) => this.append(entry, decoder.out.decode(chunk, { stream: true })))
    child.stderr?.on('data', (chunk: Buffer) => this.append(entry, decoder.err.decode(chunk, { stream: true })))
    child.on('error', (error: NodeJS.ErrnoException) => this.finish(entry, null, error.code === 'ENOENT' ? `Cannot find the shell "${program}"` : error.message))
    child.on('close', (code) => this.finish(entry, entry.info.error ? null : code))
    child.stdin?.on('error', () => {})
    this.events.changed({ ...info })
    return { ...info }
  }

  get(id: string) {
    const entry = this.entries.get(id)
    return entry && { ...entry.info }
  }

  list() {
    return [...this.entries.values()].map((entry) => ({ ...entry.info })).sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Output from `since` on. With `wait`, waits up to that many ms for new output or the end, whichever comes first. */
  async output(id: string, since = 0, wait = 0): Promise<ProcessOutput | undefined> {
    const entry = this.entries.get(id)
    if (!entry) return
    if (wait > 0 && entry.info.running && since >= entry.info.size) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          entry.waiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, wait)
        entry.waiters.add(done)
      })
    }
    const from = Math.max(since, entry.start)
    const { info } = entry
    return {
      text: entry.text.slice(from - entry.start),
      next: info.size,
      from,
      running: info.running,
      ...(info.code !== undefined ? { code: info.code } : {}),
      ...(info.error ? { error: info.error } : {}),
    }
  }

  /** Sends text to the process's standard input. */
  write(id: string, text: string) {
    const entry = this.entries.get(id)
    if (!entry?.info.running || !entry.child?.stdin?.writable) return false
    entry.child.stdin.write(text)
    return true
  }

  /** Ends the standard input, for commands that read it to the end. */
  closeInput(id: string) {
    this.entries.get(id)?.child?.stdin?.end()
  }

  stop(id: string) {
    const entry = this.entries.get(id)
    if (!entry?.info.running) return false
    entry.info.error = 'Stopped'
    killTree(entry.child?.pid)
    return true
  }

  /** Forgets a finished process. */
  remove(id: string) {
    const entry = this.entries.get(id)
    if (!entry || entry.info.running) return false
    this.entries.delete(id)
    this.events.changed({ ...entry.info, removed: true })
    return true
  }

  /** Stops everything, when the plugin unloads. */
  dispose() {
    clearTimeout(this.flushTimer)
    for (const entry of this.entries.values()) if (entry.info.running) killTree(entry.child?.pid)
    this.entries.clear()
  }

  private append(entry: Entry, text: string) {
    if (!text) return
    text = text.replace(/\r\n/g, '\n')
    entry.text += text
    entry.info.size += text.length
    const extra = entry.text.length - this.options.keep
    if (extra > 0) {
      entry.text = entry.text.slice(extra)
      entry.start += extra
    }
    for (const wake of [...entry.waiters]) wake()
    const pending = this.pending.get(entry.info.id)
    if (pending) pending.text += text
    else this.pending.set(entry.info.id, { at: entry.info.size - text.length, text })
    this.flushTimer ??= setTimeout(() => this.flush(), 80)
  }

  private flush() {
    this.flushTimer = undefined
    for (const [id, { at, text }] of this.pending) this.events.output(id, text, at)
    this.pending.clear()
  }

  private finish(entry: Entry, code: number | null, error?: string) {
    if (!entry.info.running) return
    this.flush()
    entry.info.running = false
    entry.info.endedAt = Date.now()
    entry.info.code = code
    if (error && !entry.info.error) entry.info.error = error
    for (const wake of [...entry.waiters]) wake()
    this.events.changed({ ...entry.info })
  }

  private prune() {
    const done = [...this.entries.values()].filter((entry) => !entry.info.running).sort((a, b) => a.info.startedAt - b.info.startedAt)
    for (const entry of done.slice(0, Math.max(0, done.length - this.options.history))) this.remove(entry.info.id)
  }
}
