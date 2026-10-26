import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { type Context, field, type LocalizedText, MushinError, z } from '@mushin/core'
import { FlowError, type NodeContext, type NodeResult, type NodeType, type PortDef } from '@mushin/plugin-flows'
import type {} from '@mushin/plugin-storage'
import { type CommandResult, type LocalShell, quote, quotingOf, runLocal } from './shell'
import { type HostCheck, runSsh, sameFingerprint, type SshTarget } from './ssh'

export * from './shell'
export * from './ssh'

export const name = 'terminal'
export const inject = ['flows', 'storage', 'actions']

const text = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })
const port = (name: string, type: PortDef['type'], en: string, zh: string): PortDef => ({ name, type, title: text(en, zh) })

const localShells = ['auto', 'powershell', 'pwsh', 'cmd', 'bash', 'sh'] as const

const Host = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).meta(field('Name', 'How nodes pick this server: letters, digits, - and _', {
    'zh-CN': { title: '名称', description: '节点用它选择服务器：字母、数字、- 和 _' },
  })),
  host: z.string().trim().min(1).meta(field('Address', 'Host name or IP address', {
    'zh-CN': { title: '地址', description: '主机名或 IP 地址' },
  })),
  port: z.number().int().min(1).max(65535).default(22).meta(field('Port', undefined, { 'zh-CN': { title: '端口' } })),
  username: z.string().trim().min(1).meta(field('User', undefined, { 'zh-CN': { title: '用户名' } })),
  privateKeyPath: z.string().default('').meta(field('Private key file', 'e.g. ~/.ssh/id_ed25519; a relative path starts at the instance directory', {
    'zh-CN': { title: '私钥文件', description: '例如 ~/.ssh/id_ed25519；相对路径从实例目录算起' },
  })),
  passphraseEnv: z.string().default('').meta(field('Passphrase variable', 'Environment variable that holds the private key\'s passphrase', {
    'zh-CN': { title: '私钥口令变量', description: '保存私钥口令的环境变量名' },
  })),
  passwordEnv: z.string().default('').meta(field('Password variable', 'Environment variable that holds the password; passwords are never stored in the config', {
    'zh-CN': { title: '密码变量', description: '保存密码的环境变量名；密码不会写进配置文件' },
  })),
  agent: z.boolean().default(false).meta(field('Use ssh-agent', 'Sign in with the keys of the running ssh-agent (on Windows, the OpenSSH agent service)', {
    'zh-CN': { title: '使用 ssh-agent', description: '用正在运行的 ssh-agent 中的密钥登录（Windows 上为 OpenSSH Authentication Agent 服务）' },
  })),
  fingerprint: z.string().default('').meta(field('Host key fingerprint', 'SHA256:… as ssh-keygen -lf prints it. Empty: trust the key seen on the first connection and refuse a different one later', {
    'zh-CN': { title: '主机密钥指纹', description: 'ssh-keygen -lf 输出的 SHA256:…。留空则信任首次连接时的密钥，之后密钥变化会拒绝连接' },
  })),
  shell: z.enum(['posix', 'powershell', 'cmd']).default('posix').meta(field('Remote shell', 'posix for Linux and macOS (sh, bash); powershell or cmd for Windows servers', {
    'zh-CN': { title: '远程 Shell', description: 'Linux、macOS 选 posix（sh、bash）；Windows 服务器选 powershell 或 cmd' },
  })),
})

export type HostConfig = z.infer<typeof Host>

export const Config = z.object({
  local: z.boolean().default(true).meta(field('Allow local commands', 'Turn off to allow only SSH nodes', {
    'zh-CN': { title: '允许本地命令', description: '关闭后只能使用 SSH 节点' },
  }, { widget: 'switch' })),
  shell: z.enum(localShells).default('auto').meta(field('Local shell', 'auto: PowerShell on Windows, sh elsewhere', {
    'zh-CN': { title: '本地 Shell', description: 'auto：Windows 上为 PowerShell，其他系统为 sh' },
  })),
  cwd: z.string().default('').meta(field('Working directory', 'Where local commands run; empty uses the instance directory', {
    'zh-CN': { title: '工作目录', description: '本地命令的运行目录；留空使用实例目录' },
  })),
  hosts: z.array(Host).default([]).meta(field('SSH servers', 'Servers that SSH nodes can run commands on', {
    'zh-CN': { title: 'SSH 服务器', description: 'SSH 节点可以在这些服务器上运行命令' },
  })),
  maxOutput: z.number().int().min(1).max(4096).default(64).meta(field('Output limit (KB)', 'Keep at most this much of stdout and of stderr', {
    'zh-CN': { title: '输出上限（KB）', description: 'stdout 和 stderr 各最多保留这么多' },
  })),
  runInTests: z.boolean().default(false).meta(field('Run commands in test runs', 'Off: test runs (from the editor or the Agent) show the command instead of running it', {
    'zh-CN': { title: '测试运行时执行命令', description: '关闭时，测试运行（编辑器或智能体发起）只显示将要执行的命令，不实际执行' },
  }, { widget: 'switch' })),
})

export type Config = z.infer<typeof Config>

/** What the nodes need from the running plugin; tests pass their own. */
export interface TerminalEnv {
  config: Config
  /** Base for relative paths: the instance directory. */
  baseDir: string
  checkHost(host: HostConfig): HostCheck
  env?: NodeJS.ProcessEnv
}

function expandPath(path: string, baseDir: string) {
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(baseDir, path)
}

/** The connection settings of a host, with its key file read and its secrets taken from the environment. */
export async function sshTarget(host: HostConfig, baseDir: string, env: NodeJS.ProcessEnv = process.env): Promise<SshTarget> {
  const variable = (name: string) => {
    const value = env[name]
    if (value === undefined) throw new FlowError(`The environment variable ${name} for SSH server "${host.id}" is not set`)
    return value
  }
  const target: SshTarget = { host: host.host, port: host.port, username: host.username, quoting: host.shell }
  if (host.privateKeyPath) {
    const file = expandPath(host.privateKeyPath, baseDir)
    try {
      target.privateKey = await readFile(file)
    } catch (error) {
      throw new FlowError(`Cannot read the private key ${file}: ${(error as Error).message}`)
    }
  }
  if (host.passphraseEnv) target.passphrase = variable(host.passphraseEnv)
  if (host.passwordEnv) target.password = variable(host.passwordEnv)
  if (host.agent) {
    const agent = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : env.SSH_AUTH_SOCK
    if (!agent) throw new FlowError('ssh-agent is not running (SSH_AUTH_SOCK is not set)')
    target.agent = agent
  }
  if (!target.privateKey && !target.password && !target.agent) {
    throw new FlowError(`SSH server "${host.id}" has no way to sign in: set a private key file, a password variable or ssh-agent`)
  }
  return target
}

const commandField = (en: string, zh: string) => z.string().trim().min(1).max(20_000).meta(field(
  'Command',
  `${en} References such as {{n1.rest}} are inserted as one quoted argument, so a message cannot add commands.`,
  { 'zh-CN': { title: '命令', description: `${zh}{{n1.rest}} 这样的变量引用会作为一个加了引号的参数插入，消息内容无法注入额外命令。` } },
))

const timeoutField = z.number().int().min(1).max(3600).default(30).meta(field('Timeout (s)', 'Stop the command after this many seconds', {
  'zh-CN': { title: '超时（秒）', description: '超过这么多秒后终止命令' },
}))

const cwdField = (en: string, zh: string) => z.string().default('').meta(field('Working directory', en, {
  'zh-CN': { title: '工作目录', description: zh },
}))

const inputs: PortDef[] = [port('stdin', 'text', 'Standard input', '标准输入')]

const outputs: PortDef[] = [
  port('stdout', 'text', 'Output', '输出'),
  port('stderr', 'text', 'Error output', '错误输出'),
  port('code', 'number', 'Exit code', '退出码'),
  port('error', 'text', 'Error', '错误信息'),
]

/** `ok` when the command exits with 0; `failed` otherwise, with the reason in `error`. */
function result(outcome: CommandResult): NodeResult {
  const ok = outcome.code === 0 && !outcome.error
  const error = outcome.error ?? (ok ? '' : `Exited with code ${outcome.code}`)
  return {
    exec: ok ? 'ok' : 'failed',
    outputs: {
      stdout: outcome.stdout.replace(/\s+$/, '') + (outcome.truncated ? '\n…' : ''),
      stderr: outcome.stderr.replace(/\s+$/, ''),
      code: outcome.code ?? -1,
      error,
    },
  }
}

function dryRun(where: string, command: string): NodeResult {
  return {
    exec: 'ok',
    outputs: { stdout: `[test run, not executed] ${where}: ${command}`, stderr: '', code: 0, error: '' },
  }
}

function findHost(config: Config, id: string) {
  const host = config.hosts.find((item) => item.id === id)
  if (!host) throw new FlowError(`No SSH server "${id}" in the Terminal plugin settings`)
  return host
}

/** The local and SSH node types for one plugin config. */
export function terminalNodes(env: TerminalEnv): NodeType[] {
  const { config } = env
  const limits = (context: NodeContext<{ timeout: number }>) => ({
    timeout: context.config.timeout * 1000,
    maxOutput: config.maxOutput * 1024,
    signal: context.signal,
    ...(typeof context.inputs.stdin === 'string' ? { stdin: context.inputs.stdin } : {}),
  })

  const localShell = z.enum(['default', 'powershell', 'pwsh', 'cmd', 'bash', 'sh']).default('default').meta(field('Shell', 'default uses the shell set in the Terminal plugin', {
    'zh-CN': { title: 'Shell', description: 'default 使用终端插件设置中的 Shell' },
  }))
  const shellOf = (shell: string): LocalShell => (shell === 'default' ? config.shell : shell as LocalShell)

  const local: NodeType<{ command: string; shell: string; cwd: string; timeout: number }> = {
    kind: 'action',
    type: 'terminal.local',
    category: 'action',
    restricted: true,
    title: text('Run command', '运行命令'),
    description: text(
      'Runs a command in a terminal on the machine running Mushin.js. Continues on "ok" when it exits with 0, else on "failed". Only people can add it in the editor, not the Agent.',
      '在运行 Mushin.js 的电脑上的终端里执行命令。退出码为 0 时走“ok”，否则走“failed”。只能由人在编辑器中添加，智能体不能。',
    ),
    config: z.object({
      command: commandField('Runs in the shell below.', '在下面选择的 Shell 中运行。'),
      shell: localShell,
      cwd: cwdField('Empty uses the Terminal plugin\'s working directory', '留空使用终端插件设置的工作目录'),
      timeout: timeoutField,
    }),
    escapeConfig: { command: (value, raw) => quote(value, quotingOf(shellOf(raw.shell ?? 'default'))) },
    inputs,
    outputs,
    execOut: ['ok', 'failed'],
    async run(context) {
      if (!config.local) throw new FlowError('Local commands are turned off in the Terminal plugin settings')
      const shell = shellOf(context.config.shell)
      if (context.test && !config.runInTests) return dryRun(`local ${shell}`, context.config.command)
      const cwd = expandPath(context.config.cwd || config.cwd || '.', env.baseDir)
      const outcome = await runLocal(context.config.command, { ...limits(context), shell, cwd, env: env.env })
      context.logger.info('[%s] local command exited with %s in %d ms: %s', context.node.label, outcome.error ?? outcome.code, outcome.ms, context.config.command)
      return result(outcome)
    },
  }

  const ids = config.hosts.map((host) => host.id)
  const hostField = (ids.length ? z.enum(ids as [string, ...string[]]).default(ids[0]) : z.string().default('')).meta(field(
    'Server',
    'An SSH server from the Terminal plugin settings',
    { 'zh-CN': { title: '服务器', description: '终端插件设置中的 SSH 服务器' } },
  ))

  const ssh: NodeType<{ host: string; command: string; cwd: string; timeout: number }> = {
    kind: 'action',
    type: 'terminal.ssh',
    category: 'action',
    restricted: true,
    title: text('Run over SSH', 'SSH 执行命令'),
    description: text(
      'Signs in to a server set up in the Terminal plugin and runs a command there. Continues on "ok" when it exits with 0, else on "failed". Only people can add it in the editor, not the Agent.',
      '登录终端插件中设置的服务器并在上面执行命令。退出码为 0 时走“ok”，否则走“failed”。只能由人在编辑器中添加，智能体不能。',
    ),
    config: z.object({
      host: hostField,
      command: commandField('Runs in the server\'s shell.', '在服务器的 Shell 中运行。'),
      cwd: cwdField('Empty uses the login directory', '留空使用登录后的目录'),
      timeout: timeoutField,
    }),
    escapeConfig: {
      command: (value, raw) => quote(value, config.hosts.find((host) => host.id === raw.host)?.shell ?? 'posix'),
    },
    inputs,
    outputs,
    execOut: ['ok', 'failed'],
    async run(context) {
      const host = findHost(config, context.config.host)
      if (context.test && !config.runInTests) return dryRun(`${host.username}@${host.host}`, context.config.command)
      const target = await sshTarget(host, env.baseDir, env.env)
      const outcome = await runSsh(target, context.config.command, {
        ...limits(context),
        ...(context.config.cwd ? { cwd: context.config.cwd } : {}),
        checkHost: env.checkHost(host),
      })
      context.logger.info('[%s] command on %s exited with %s in %d ms: %s', context.node.label, host.id, outcome.error ?? outcome.code, outcome.ms, context.config.command)
      return result(outcome)
    },
  }

  return [local, ssh]
}

interface KnownHost {
  fingerprint: string
  host: string
  port: number
  at: number
}

const knownKey = (host: HostConfig) => `terminal/known-hosts/${`${host.host}_${host.port}`.replace(/[^A-Za-z0-9_.-]/g, '_')}`

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('terminal')
  const seen = new Set<string>()
  for (const host of config.hosts) {
    if (seen.has(host.id)) throw new Error(`Two SSH servers are named "${host.id}"`)
    seen.add(host.id)
  }

  /** Pinned fingerprint, else trust on first use: remember the first key and refuse any other. */
  const checkHost = (host: HostConfig): HostCheck => async (fingerprint) => {
    if (host.fingerprint) {
      return sameFingerprint(host.fingerprint, fingerprint) || `The host key of ${host.host} is ${fingerprint}, not the fingerprint set for "${host.id}"`
    }
    const known = await ctx.storage.get<KnownHost>(knownKey(host))
    if (known) {
      return sameFingerprint(known.fingerprint, fingerprint)
        || `The host key of ${host.host} changed from ${known.fingerprint} to ${fingerprint}. If the server was reinstalled, forget the old key (terminal.hosts.forget) or set the new fingerprint`
    }
    await ctx.storage.set(knownKey(host), { fingerprint, host: host.host, port: host.port, at: Date.now() } satisfies KnownHost)
    logger.info('trusting the host key of %s (%s:%d) on first use: %s', host.id, host.host, host.port, fingerprint)
    return true
  }

  for (const node of terminalNodes({ config, baseDir: ctx.baseDir ?? process.cwd(), checkHost })) ctx.flows.defineNode(node)

  const hostInput = z.object({ id: z.string().describe('SSH server name from terminal.hosts.list') })
  const hostOf = (id: string) => {
    const host = config.hosts.find((item) => item.id === id)
    if (!host) throw new MushinError('not_found', `No SSH server "${id}"`)
    return host
  }

  ctx.actions.define({
    name: 'terminal.hosts.list',
    description: 'List the SSH servers set up in the Terminal plugin (no secrets): address, user, how it signs in, and the host key it trusts. Terminal nodes can only be added by the user in the flow editor.',
    risk: 'read',
    input: z.object({}),
    handler: async () => Promise.all(config.hosts.map(async (host) => ({
      id: host.id,
      host: host.host,
      port: host.port,
      username: host.username,
      shell: host.shell,
      signIn: [host.privateKeyPath && 'key file', host.passwordEnv && 'password', host.agent && 'ssh-agent'].filter(Boolean),
      pinnedFingerprint: host.fingerprint || undefined,
      knownFingerprint: (await ctx.storage.get<KnownHost>(knownKey(host)))?.fingerprint,
    }))),
  })

  ctx.actions.define({
    name: 'terminal.hosts.check',
    description: 'Sign in to an SSH server of the Terminal plugin and disconnect, without running anything. Returns whether it worked and the server\'s host key fingerprint; the first successful check remembers the key.',
    risk: 'write',
    input: hostInput,
    handler: async ({ id }) => {
      const host = hostOf(id)
      let target: SshTarget
      try {
        target = await sshTarget(host, ctx.baseDir ?? process.cwd())
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
      const outcome = await runSsh(target, 'exit 0', { timeout: 20_000, maxOutput: 4096, checkHost: checkHost(host) })
      return { ok: !outcome.error && outcome.code === 0, fingerprint: outcome.fingerprint, ...(outcome.error ? { error: outcome.error } : {}) }
    },
  })

  ctx.actions.define({
    name: 'terminal.hosts.forget',
    description: 'Forget the remembered host key of an SSH server, so the next connection trusts whatever key the server shows. Only for a server that was reinstalled.',
    risk: 'dangerous',
    input: hostInput,
    handler: async ({ id }) => {
      await ctx.storage.delete(knownKey(hostOf(id)))
      return { forgotten: id }
    },
  })
}
