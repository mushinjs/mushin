import { spawn } from 'node:child_process'

/** How a shell reads quoted text: POSIX shells (sh, bash, zsh), PowerShell, or Windows cmd. */
export type Quoting = 'posix' | 'powershell' | 'cmd'

/** Local shells. `auto` is PowerShell on Windows and sh elsewhere. */
export type LocalShell = 'auto' | 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh'

export class QuoteError extends Error {
  name = 'QuoteError'
}

/**
 * Quotes a value as one argument, so text from a chat message cannot end the argument and add
 * commands of its own. cmd has no quoting that is safe for every character, so values with `"`,
 * `%`, `!` or line breaks are refused there.
 */
export function quote(value: string, quoting: Quoting) {
  if (quoting === 'posix') return `'${value.replace(/'/g, `'\\''`)}'`
  // PowerShell also takes the typographic single quotes as quotes.
  if (quoting === 'powershell') return `'${value.replace(/['‘’‚‛]/g, '$&$&')}'`
  if (/["%!\r\n]/.test(value)) throw new QuoteError('cmd cannot safely quote a value with ", %, ! or a line break; use PowerShell instead')
  return `"${value}"`
}

export function resolveShell(shell: LocalShell, platform = process.platform): Exclude<LocalShell, 'auto'> {
  if (shell !== 'auto') return shell
  return platform === 'win32' ? 'powershell' : 'sh'
}

export function quotingOf(shell: LocalShell, platform = process.platform): Quoting {
  const resolved = resolveShell(shell, platform)
  if (resolved === 'cmd') return 'cmd'
  if (resolved === 'powershell' || resolved === 'pwsh') return 'powershell'
  return 'posix'
}

/** A PowerShell script that prints UTF-8 and exits with the command's exit code. */
export function powershellScript(command: string) {
  return [
    '$ProgressPreference = "SilentlyContinue"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    '$global:LASTEXITCODE = 0',
    `& {\n${command}\n}`,
    '$succeeded = $?',
    'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
    'if (-not $succeeded) { exit 1 }',
  ].join('\n')
}

/** Plain text in and out: without them, PowerShell may write errors and progress as CLIXML. */
export const POWERSHELL_FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'Text', '-OutputFormat', 'Text']

/** `-EncodedCommand` takes UTF-16LE in base64, which avoids every command-line quoting rule. */
export function encodePowershell(command: string) {
  return Buffer.from(powershellScript(command), 'utf16le').toString('base64')
}

/** The program and arguments that run a command in a local shell. */
export function shellCommand(shell: LocalShell, command: string, platform = process.platform) {
  const resolved = resolveShell(shell, platform)
  switch (resolved) {
    case 'powershell':
    case 'pwsh': {
      const program = resolved === 'powershell' ? (platform === 'win32' ? 'powershell.exe' : 'powershell') : 'pwsh'
      return { program, args: [...POWERSHELL_FLAGS, '-EncodedCommand', encodePowershell(command)], verbatim: false }
    }
    case 'cmd':
      // As Node's own `shell: true` does on Windows; code page 65001 makes the output UTF-8.
      return { program: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`], verbatim: true }
    default:
      return { program: resolved === 'bash' ? 'bash' : '/bin/sh', args: ['-c', command], verbatim: false }
  }
}

export interface RunOptions {
  /** Kills the command after this many milliseconds. */
  timeout: number
  /** Keeps at most this many bytes of stdout and of stderr. */
  maxOutput: number
  stdin?: string
  signal?: AbortSignal
}

export interface CommandResult {
  stdout: string
  stderr: string
  /** Exit code; null when the command was killed or never started. */
  code: number | null
  timedOut: boolean
  /** Output beyond `maxOutput` was dropped. */
  truncated: boolean
  /** Why the command could not run or was stopped. */
  error?: string
  ms: number
}

/** Collects one output stream up to a byte limit. */
export class OutputBuffer {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false

  constructor(private limit: number) {}

  push(chunk: Buffer | string) {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    const room = this.limit - this.size
    if (room <= 0) {
      if (data.length) this.truncated = true
      return
    }
    const kept = data.length > room ? data.subarray(0, room) : data
    if (kept.length < data.length) this.truncated = true
    this.chunks.push(kept)
    this.size += kept.length
  }

  text() {
    return new TextDecoder().decode(Buffer.concat(this.chunks)).replace(/\r\n/g, '\n')
  }
}

/** Ends a local command and the processes it started. */
function killTree(pid: number | undefined) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {}
}

/** Runs a command in a local shell and collects its output. Never throws. */
export function runLocal(command: string, options: RunOptions & { shell: LocalShell; cwd?: string; env?: NodeJS.ProcessEnv }): Promise<CommandResult> {
  const started = Date.now()
  const { program, args, verbatim } = shellCommand(options.shell, command)
  const stdout = new OutputBuffer(options.maxOutput)
  const stderr = new OutputBuffer(options.maxOutput)
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let stopped: string | undefined
    const finish = (code: number | null, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      resolve({
        stdout: stdout.text(),
        stderr: stderr.text(),
        code,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        ...(error ?? stopped ? { error: error ?? stopped } : {}),
        ms: Date.now() - started,
      })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(program, args, {
        cwd: options.cwd || undefined,
        env: options.env ?? process.env,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        // Its own process group, so a timeout can end everything the command started.
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      finish(null, `Cannot start ${program}: ${(error as Error).message}`)
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      stopped = `Timed out after ${Math.round(options.timeout / 1000)} s`
      killTree(child.pid)
    }, options.timeout)
    const abort = () => {
      stopped = 'Stopped with the flow run'
      killTree(child.pid)
    }
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout?.on('data', (chunk) => stdout.push(chunk))
    child.stderr?.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error: NodeJS.ErrnoException) => finish(null, error.code === 'ENOENT' ? `Cannot find the shell "${program}"` : error.message))
    child.on('close', (code) => finish(stopped ? null : code))
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.stdin ?? '')
  })
}
