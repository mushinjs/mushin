import { createHash } from 'node:crypto'
import { Client, type ConnectConfig } from 'ssh2'
import { type CommandResult, encodePowershell, OutputBuffer, POWERSHELL_FLAGS, quote, type Quoting, type RunOptions } from './shell'

/** `SHA256:…` as OpenSSH prints it (`ssh-keygen -lf`), from the raw host key. */
export function fingerprint(key: Buffer) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/** Accepts `SHA256:abc`, `abc` and `abc=` as the same fingerprint. */
export function sameFingerprint(a: string, b: string) {
  const norm = (value: string) => value.trim().replace(/^SHA256:/i, '').replace(/=+$/, '')
  return norm(a) === norm(b)
}

export interface SshTarget {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: Buffer | string
  passphrase?: string
  /** An ssh-agent socket, or Pageant / the OpenSSH agent pipe on Windows. */
  agent?: string
  /** The remote login shell, for quoting and for running PowerShell. */
  quoting: Quoting
  readyTimeout?: number
}

/**
 * Says whether a server's host key is trusted. Gets the fingerprint and returns true to connect;
 * a string is the reason to refuse.
 */
export type HostCheck = (fingerprint: string) => Promise<true | string> | true | string

/** The command as the remote login shell should get it, in `cwd` when given. */
export function remoteCommand(command: string, quoting: Quoting, cwd?: string) {
  if (quoting === 'powershell') {
    const script = cwd ? `Set-Location -LiteralPath ${quote(cwd, 'powershell')}\n${command}` : command
    // Works whether the server's default shell is cmd or PowerShell.
    return `powershell ${POWERSHELL_FLAGS.join(' ')} -EncodedCommand ${encodePowershell(script)}`
  }
  if (!cwd) return command
  return quoting === 'cmd' ? `cd /d ${quote(cwd, 'cmd')} && ${command}` : `cd ${quote(cwd, 'posix')} && ${command}`
}

/** Connects, runs one command and disconnects. Never throws. */
export function runSsh(target: SshTarget, command: string, options: RunOptions & { cwd?: string; checkHost: HostCheck }): Promise<CommandResult & { fingerprint?: string }> {
  const started = Date.now()
  const stdout = new OutputBuffer(options.maxOutput)
  const stderr = new OutputBuffer(options.maxOutput)
  const client = new Client()
  let seen: string | undefined
  let refused: string | undefined

  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    const finish = (code: number | null, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      client.end()
      resolve({
        stdout: stdout.text(),
        stderr: stderr.text(),
        code,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        ...(error ? { error } : {}),
        ...(seen ? { fingerprint: seen } : {}),
        ms: Date.now() - started,
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      finish(null, `Timed out after ${Math.round(options.timeout / 1000)} s`)
    }, options.timeout)
    const abort = () => finish(null, 'Stopped with the flow run')
    if (options.signal?.aborted) return abort()
    options.signal?.addEventListener('abort', abort, { once: true })

    client.on('error', (error) => {
      if (refused) return finish(null, refused)
      const level = (error as { level?: string }).level
      finish(null, level === 'client-authentication' ? `Authentication failed for ${target.username}@${target.host}` : error.message)
    })
    client.on('ready', () => {
      client.exec(remoteCommand(command, target.quoting, options.cwd), (error, stream) => {
        if (error) return finish(null, error.message)
        let code: number | null = null
        stream.on('exit', (exitCode: number | null) => {
          code = exitCode
        })
        stream.on('data', (chunk: Buffer) => stdout.push(chunk))
        stream.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        stream.on('close', () => finish(code))
        stream.end(options.stdin ?? '')
      })
    })

    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: target.readyTimeout ?? Math.min(options.timeout, 20_000),
      hostVerifier: ((key: Buffer, verify: (valid: boolean) => void) => {
        seen = fingerprint(key)
        Promise.resolve(options.checkHost(seen)).then(
          (result) => {
            if (result !== true) refused = result
            verify(result === true)
          },
          (error) => {
            refused = String((error as Error)?.message ?? error)
            verify(false)
          },
        )
      }) as any,
      ...(target.password ? { password: target.password } : {}),
      ...(target.privateKey ? { privateKey: target.privateKey } : {}),
      ...(target.passphrase ? { passphrase: target.passphrase } : {}),
      ...(target.agent ? { agent: target.agent } : {}),
    }
    try {
      client.connect(config)
    } catch (error) {
      finish(null, (error as Error).message)
    }
  })
}
