import { describe, expect, it } from 'vitest'
import { seg } from '@mushin/core'
import { builtinNodes, compile, type FlowDocument, type FlowSession, type NodeType, runFlow } from '@mushin/plugin-flows'
import { Server, utils } from 'ssh2'
import { Config, fingerprint, type HostCheck, OutputBuffer, quote, remoteCommand, runLocal, terminalNodes } from '../src'

const logger = { info() {}, warn() {}, debug() {}, error() {} } as any
const posix = process.platform !== 'win32'

function doc(nodes: { id: string; type: string; config?: any; inputs?: any }[], edges: [string, string, string][] = []): FlowDocument {
  return {
    id: 'f1',
    name: 'Terminal',
    bots: [],
    nodes: nodes.map((node) => ({ ...node, position: { x: 0, y: 0 }, config: node.config ?? {} })),
    edges: edges.map(([source, handle, target], index) => ({ id: `e${index}`, source, sourceHandle: `exec:${handle}`, target, targetHandle: 'exec' })),
    createdAt: 0,
    updatedAt: 0,
  }
}

function session(text: string): FlowSession {
  return {
    text,
    segments: [seg.text(text)],
    user: { id: '42', name: 'Ann' },
    channel: { type: 'group', id: '500' },
    isDirect: false,
    mentioned: false,
    send: async () => ({ messageId: 's1' }),
    reply: async () => ({ messageId: 's1' }),
  }
}

/** Runs one terminal node after a message trigger and returns its step. */
async function runNode(node: { type: string; config?: any; inputs?: any }, options: { text?: string; config?: any; test?: boolean; checkHost?: HostCheck; env?: NodeJS.ProcessEnv } = {}) {
  const config = Config.parse(options.config ?? {})
  const types = new Map<string, NodeType>([...builtinNodes, ...terminalNodes({ config, baseDir: process.cwd(), checkHost: () => options.checkHost ?? (() => true), env: options.env })].map((type) => [type.type, type]))
  const compiled = compile(doc([{ id: 't', type: 'trigger.message' }, { id: 'n', ...node }], [['t', 'next', 'n']]), types)
  expect(compiled.issues.filter((issue) => issue.severity === 'error')).toEqual([])
  const result = await runFlow(compiled, { session: session(options.text ?? 'hi'), vars: { get() {}, set() {} }, logger, test: options.test })
  const step = result.trace.steps.find((item) => item.nodeId === 'n')!
  return { step, trace: result.trace }
}

const nasty = [`it's`, `"; rm -rf / #`, '$(whoami) `id` $HOME', 'a\nb', '‘smart’ quotes', '%PATH% !x! ^&|<>', '']

describe('quoting', () => {
  it.runIf(posix)('POSIX quotes survive the shell unchanged', async () => {
    for (const value of nasty) {
      const outcome = await runLocal(`printf %s ${quote(value, 'posix')}`, { shell: 'sh', timeout: 5000, maxOutput: 4096 })
      expect(outcome.stdout).toBe(value)
    }
  })

  it('PowerShell doubles every kind of single quote', () => {
    expect(quote(`it's ‘x’`, 'powershell')).toBe(`'it''s ‘‘x’’'`)
    expect(quote('$(whoami)', 'powershell')).toBe(`'$(whoami)'`)
  })

  it('cmd refuses what it cannot quote', () => {
    expect(quote('a & b | c', 'cmd')).toBe('"a & b | c"')
    for (const value of ['"', '%PATH%', '!x!', 'a\nb']) expect(() => quote(value, 'cmd')).toThrow(/cmd cannot/)
  })

  it('remote commands get the working directory and PowerShell wrapping', () => {
    expect(remoteCommand('ls', 'posix', "/srv/it's")).toBe(`cd '/srv/it'\\''s' && ls`)
    expect(remoteCommand('dir', 'cmd', 'C:\\app')).toBe('cd /d "C:\\app" && dir')
    const wrapped = remoteCommand('Get-Date', 'powershell', 'C:\\app')
    const script = Buffer.from(wrapped.split(' ').pop()!, 'base64').toString('utf16le')
    expect(script).toContain("Set-Location -LiteralPath 'C:\\app'\nGet-Date")
  })

  it('keeps output within the limit', () => {
    const buffer = new OutputBuffer(5)
    buffer.push('abc')
    buffer.push('defg')
    expect(buffer.text()).toBe('abcde')
    expect(buffer.truncated).toBe(true)
  })
})

describe.runIf(posix)('local command node', () => {
  it('inserts a message as one argument, so it cannot run commands', async () => {
    const { step } = await runNode({ type: 'terminal.local', config: { command: 'printf "%s|" {{sys.text}}', shell: 'sh' } }, { text: 'a b; echo pwned $(id)' })
    expect(step.exec).toBe('ok')
    expect(step.outputs).toMatchObject({ stdout: 'a b; echo pwned $(id)|', code: 0, error: '' })
  })

  it('passes stdin and reports a failing exit code', async () => {
    const { step } = await runNode({ type: 'terminal.local', config: { command: 'cat; echo oops >&2; exit 3', shell: 'sh' }, inputs: { stdin: 'from {{sys.text}}' } }, { text: 'chat' })
    expect(step.exec).toBe('failed')
    expect(step.outputs).toMatchObject({ stdout: 'from chat', stderr: 'oops', code: 3, error: 'Exited with code 3' })
  })

  it('stops a command at its timeout, with what it printed so far', async () => {
    const started = Date.now()
    const { step } = await runNode({ type: 'terminal.local', config: { command: 'echo started; sleep 30', shell: 'sh', timeout: 1 } })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(step.exec).toBe('failed')
    expect(step.outputs).toMatchObject({ stdout: 'started', code: -1, error: 'Timed out after 1 s' })
  })

  it('shows the command instead of running it in test runs', async () => {
    const { step } = await runNode({ type: 'terminal.local', config: { command: 'touch /tmp/never {{sys.text}}', shell: 'sh' } }, { text: "x'y", test: true })
    expect(step.outputs?.stdout).toBe(`[test run, not executed] local sh: touch /tmp/never 'x'\\''y'`)
  })

  it('can be turned off', async () => {
    const { trace } = await runNode({ type: 'terminal.local', config: { command: 'true' } }, { config: { local: false } })
    expect(trace.error).toMatch(/turned off/)
  })
})

describe('node registry', () => {
  it('marks both nodes restricted and offers the configured servers', () => {
    const config = Config.parse({ hosts: [{ id: 'web', host: 'example.com', username: 'deploy', agent: true }] })
    const nodes = terminalNodes({ config, baseDir: '.', checkHost: () => () => true })
    expect(nodes.map((node) => [node.type, node.restricted])).toEqual([['terminal.local', true], ['terminal.ssh', true]])
    const ssh = nodes.find((node) => node.type === 'terminal.ssh')!
    expect(ssh.config!.parse({ command: 'ls' })).toMatchObject({ host: 'web', timeout: 30 })
    expect(ssh.config!.safeParse({ host: 'other', command: 'ls' }).success).toBe(false)
  })
})

/** An SSH server that answers each command with the command it received, as `got:<command>`. */
async function sshServer(password: string) {
  const hostKey = utils.generateKeyPairSync('ed25519')
  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('authentication', (context) => {
      if (context.method === 'password' && context.username === 'deploy' && context.password === password) context.accept()
      else context.reject(['password'])
    })
    client.on('session', (accept) => {
      accept().on('exec', (accept, _reject, info) => {
        const stream = accept()
        if (info.command.startsWith('exit ')) {
          stream.exit(Number(info.command.slice(5)))
          return stream.end()
        }
        let input = ''
        stream.on('data', (chunk: Buffer) => { input += chunk })
        stream.on('end', () => {
          stream.write(`got:${info.command}${input ? ` stdin:${input}` : ''}`)
          stream.stderr.write('warn')
          stream.exit(0)
          stream.end()
        })
      })
    })
    client.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const publicKey = utils.parseKey(hostKey.public)
  const key = (Array.isArray(publicKey) ? publicKey[0] : publicKey) as { getPublicSSH(): Buffer }
  return { port, fingerprint: fingerprint(key.getPublicSSH()), close: () => server.close() }
}

describe('SSH node', () => {
  it('signs in with a password from the environment and runs the quoted command', async () => {
    const server = await sshServer('s3cret')
    try {
      const config = { hosts: [{ id: 'web', host: '127.0.0.1', port: server.port, username: 'deploy', passwordEnv: 'WEB_PASSWORD' }] }
      const seen: string[] = []
      const { step } = await runNode(
        { type: 'terminal.ssh', config: { host: 'web', command: 'grep -r {{sys.text}} .', cwd: '/srv/app' }, inputs: { stdin: 'data' } },
        { text: "x'; reboot", config, env: { WEB_PASSWORD: 's3cret' }, checkHost: (value) => (seen.push(value), true) },
      )
      expect(step.exec).toBe('ok')
      expect(step.outputs).toMatchObject({ stdout: `got:cd '/srv/app' && grep -r 'x'\\''; reboot' . stdin:data`, stderr: 'warn', code: 0 })
      expect(seen).toEqual([server.fingerprint])
    } finally {
      server.close()
    }
  })

  it('refuses a host key it does not trust, and a wrong password', async () => {
    const server = await sshServer('s3cret')
    try {
      const config = { hosts: [{ id: 'web', host: '127.0.0.1', port: server.port, username: 'deploy', passwordEnv: 'PW' }] }
      const node = { type: 'terminal.ssh', config: { host: 'web', command: 'ls' } }
      const refused = await runNode(node, { config, env: { PW: 's3cret' }, checkHost: () => 'The host key changed' })
      expect(refused.step.outputs).toMatchObject({ error: 'The host key changed' })
      const wrong = await runNode(node, { config, env: { PW: 'nope' } })
      expect(wrong.step.exec).toBe('failed')
      expect(wrong.step.outputs?.error).toMatch(/Authentication failed/)
      const exit = await runNode({ type: 'terminal.ssh', config: { host: 'web', command: 'exit 4' } }, { config, env: { PW: 's3cret' } })
      expect(exit.step.outputs).toMatchObject({ code: 4, error: 'Exited with code 4' })
      const missing = await runNode(node, { config, env: {} })
      expect(missing.trace.error).toMatch(/PW .*is not set/)
    } finally {
      server.close()
    }
  })
})

describe.runIf(process.platform === 'win32')('Windows shells', () => {
  const run = (command: string, shell: 'powershell' | 'cmd') => runLocal(command, { shell, timeout: 20_000, maxOutput: 4096 })

  it('PowerShell: quoted values, UTF-8 output and exit codes', async () => {
    for (const value of [`it's`, '$(whoami) `id`', '‘smart’', '你好']) {
      const outcome = await run(`[Console]::Out.Write(${quote(value, 'powershell')})`, 'powershell')
      expect(outcome.stdout).toBe(value)
    }
    expect((await run('cmd /c exit 3', 'powershell')).code).toBe(3)
    expect((await run("throw 'boom'", 'powershell')).code).toBe(1)
    expect((await run("Write-Output 'fine'", 'powershell'))).toMatchObject({ code: 0, stdout: 'fine\n' })
  })

  it('cmd: quoted values and exit codes', async () => {
    expect((await run(`echo ${quote('a & b | c', 'cmd')}`, 'cmd')).stdout).toBe('"a & b | c"\n')
    expect((await run('exit /b 5', 'cmd')).code).toBe(5)
  })
})
