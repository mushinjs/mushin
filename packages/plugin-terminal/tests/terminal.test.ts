import { describe, expect, it } from 'vitest'
import { seg } from '@mushin/core'
import { builtinNodes, compile, type FlowDocument, type FlowSession, type NodeType, runFlow } from '@mushin/plugin-flows'
import { Config, OutputBuffer, quote, runLocal, terminalNodes } from '../src'

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
async function runNode(node: { type: string; config?: any; inputs?: any }, options: { text?: string; config?: any; test?: boolean } = {}) {
  const config = Config.parse(options.config ?? {})
  const types = new Map<string, NodeType>([...builtinNodes, ...terminalNodes({ config, baseDir: process.cwd() })].map((type) => [type.type, type]))
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
  it('marks the node restricted', () => {
    const nodes = terminalNodes({ config: Config.parse({}), baseDir: '.' })
    expect(nodes.map((node) => [node.type, node.restricted])).toEqual([['terminal.local', true]])
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
