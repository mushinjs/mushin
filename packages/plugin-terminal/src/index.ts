import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { type Context, field, type LocalizedText, MushinError, z } from '@mushinjs/core'
import { FlowError, type NodeContext, type NodeResult, type NodeType, type PortDef } from '@mushinjs/plugin-flows'
import type {} from '@mushinjs/plugin-storage'
import { editText, type FileRoots, listFiles, readText, searchFiles, writeText } from './files'
import { type ProcessInfo, Processes } from './processes'
import { isReadOnlyCommand } from './readonly'
import { type CommandResult, type LocalShell, quote, quotingOf, resolveShell, runLocal } from './shell'
import { type HostCheck, runSsh, sameFingerprint, type SshTarget } from './ssh'

export * from './files'
export * from './processes'
export * from './readonly'
export * from './shell'
export * from './ssh'

declare module '@mushinjs/core' {
  interface Events {
    /** A command started, ended or was forgotten. */
    'terminal/process'(info: ProcessInfo & { removed?: boolean }): void
    /** New output of a command, in batches. */
    'terminal/output'(data: { id: string; text: string; at: number }): void
  }
}

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
  runInTests: z.boolean().default(false).meta(field('Run commands in test runs', 'Off: test runs (from the editor or Fairy) show the command instead of running it', {
    'zh-CN': { title: '测试运行时执行命令', description: '关闭时，测试运行（编辑器或 Fairy 发起）只显示将要执行的命令，不实际执行' },
  }, { widget: 'switch' })),
  fairyCommands: z.enum(['off', 'ask', 'readonly', 'auto']).default('ask').meta(field('Fairy runs commands', 'Whether Fairy may run commands on this machine (in the working directory, as the user running Mushin.js): off; ask every time; run commands that only look (list, read, git status) without asking; or run everything without asking. A policy set for a tool in the Fairy settings comes first', {
    'zh-CN': {
      title: 'Fairy 运行命令',
      description: 'Fairy 能否在本机运行命令（在工作目录中，以运行 Mushin.js 的用户身份）：关闭；每次都先问；只查看的命令（列目录、读文件、git status）直接运行；或全部直接运行。Fairy 设置里为某个工具设的策略优先',
      options: { off: '关闭', ask: '每次都先问', readonly: '只查看的命令直接运行', auto: '全部直接运行' },
    },
  }, { options: { off: 'Off', ask: 'Ask every time', readonly: 'Run look-only commands without asking', auto: 'Run everything without asking' } })),
  fairyFiles: z.enum(['off', 'read', 'write']).default('write').meta(field('Fairy reads and writes files', 'Files in the app folder and the extra folders below: off, read only, or read and write. .env files are never touched, and writes stay out of data/, node_modules/ and .git/. Writes outside the plugin folders ask first', {
    'zh-CN': {
      title: 'Fairy 读写文件',
      description: '应用目录和下面额外目录里的文件：关闭、只读、可读写。永远不碰 .env，写入不会进入 data/、node_modules/ 和 .git/。插件目录以外的写入会先问你',
      options: { off: '关闭', read: '只读', write: '可读写' },
    },
  }, { options: { off: 'Off', read: 'Read only', write: 'Read and write' } })),
  fairyRoots: z.array(z.string()).default([]).meta(field('Extra folders for Fairy', 'Folders besides the app folder that Fairy\'s file tools may use, such as a plugins folder shared with another instance', {
    'zh-CN': { title: 'Fairy 可用的额外目录', description: '除应用目录外，Fairy 的文件工具还能使用的目录，例如和其他实例共用的插件目录' },
  })),
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

const timeoutField = z.number().int().min(1).max(86_400).default(30).meta(field('Timeout (s)', 'Stop the command after this many seconds, at most a day. The time does not count toward the run\'s one-minute working limit', {
  'zh-CN': { title: '超时（秒）', description: '超过这么多秒后终止命令，最长一天。这段时间不计入运行一分钟的工作时间上限' },
}))

const resourceField = z.string().trim().max(40).default('').meta(field('Resource', 'Runs whose nodes name the same resource (e.g. bettergi) take turns: one run holds it from this node until it ends, the others queue. Empty: no queue', {
  'zh-CN': { title: '占用资源', description: '填写相同资源名（例如 bettergi）的运行会轮流使用：一个运行从这个节点起占用它直到运行结束，其他运行排队等候。留空则不排队' },
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

  const local: NodeType<{ command: string; shell: string; cwd: string; timeout: number; resource: string }> = {
    kind: 'action',
    type: 'terminal.local',
    category: 'action',
    restricted: true,
    title: text('Run command', '运行命令'),
    description: text(
      'Runs a command in a terminal on the machine running Mushin.js. Continues on "ok" when it exits with 0, else on "failed". Only people can add it in the editor, not Fairy.',
      '在运行 Mushin.js 的电脑上的终端里执行命令。退出码为 0 时走“ok”，否则走“failed”。只能由人在编辑器中添加，Fairy 不能。',
    ),
    config: z.object({
      command: commandField('Runs in the shell below.', '在下面选择的 Shell 中运行。'),
      shell: localShell,
      cwd: cwdField('Empty uses the Terminal plugin\'s working directory', '留空使用终端插件设置的工作目录'),
      timeout: timeoutField,
      resource: resourceField,
    }),
    escapeConfig: { command: (value, raw) => quote(value, quotingOf(shellOf(raw.shell ?? 'default'))) },
    inputs,
    outputs,
    execOut: ['ok', 'failed'],
    long: true,
    resource: (values) => values.resource || undefined,
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

  const ssh: NodeType<{ host: string; command: string; cwd: string; timeout: number; resource: string }> = {
    kind: 'action',
    type: 'terminal.ssh',
    category: 'action',
    restricted: true,
    title: text('Run over SSH', 'SSH 执行命令'),
    description: text(
      'Signs in to a server set up in the Terminal plugin and runs a command there. Continues on "ok" when it exits with 0, else on "failed". Only people can add it in the editor, not Fairy.',
      '登录终端插件中设置的服务器并在上面执行命令。退出码为 0 时走“ok”，否则走“failed”。只能由人在编辑器中添加，Fairy 不能。',
    ),
    config: z.object({
      host: hostField,
      command: commandField('Runs in the server\'s shell.', '在服务器的 Shell 中运行。'),
      cwd: cwdField('Empty uses the login directory', '留空使用登录后的目录'),
      timeout: timeoutField,
      resource: resourceField,
    }),
    escapeConfig: {
      command: (value, raw) => quote(value, config.hosts.find((host) => host.id === raw.host)?.shell ?? 'posix'),
    },
    inputs,
    outputs,
    execOut: ['ok', 'failed'],
    long: true,
    resource: (values) => values.resource || undefined,
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

  defineFairyTools(ctx, config)
}

/** Output as Fairy reads it: without color codes and cursor moves, and with each line's last carriage-return redraw. */
const plain = (text: string) => text
  // eslint-disable-next-line no-control-regex
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, '')
  .split('\n').map((line) => line.slice(line.lastIndexOf('\r') + 1)).join('\n')

/** The tools that let Fairy work on this machine: commands, long-running processes and files. */
function defineFairyTools(ctx: Context, config: Config) {
  const baseDir = ctx.baseDir ?? process.cwd()
  const workDir = config.cwd ? expandPath(config.cwd, baseDir) : baseDir
  const extraRoots = config.fairyRoots.filter(Boolean).map((root) => expandPath(root, baseDir))
  /** The folders local plugins load from, as the plugin manager has them now (they can change at runtime). */
  const pluginDirs = () => ctx.get('manager')?.localDirs ?? [join(baseDir, 'plugins')]
  /** The app folder first, then the plugin folders and the extra ones from the settings. */
  const fileRoots = (): FileRoots => ({ roots: [...new Set([baseDir, ...pluginDirs(), ...extraRoots])] })
  const processes = new Processes({
    changed: (info) => ctx.emit('terminal/process', info),
    output: (id, text, at) => ctx.emit('terminal/output', { id, text, at }),
  })
  ctx.effect(() => () => processes.dispose(), 'terminal.processes')

  const commandsOn = () => {
    if (!config.local) throw new MushinError('forbidden', 'Local commands are turned off in the Terminal plugin settings')
    if (config.fairyCommands === 'off') throw new MushinError('forbidden', 'Fairy may not run commands: the Terminal plugin\'s "Fairy runs commands" setting is off')
  }
  const filesOn = (write = false) => {
    if (config.fairyFiles === 'off' || (write && config.fairyFiles !== 'write')) {
      throw new MushinError('forbidden', `Fairy may not ${write ? 'write' : 'read'} files: see the Terminal plugin's "Fairy reads and writes files" setting`)
    }
  }
  /** Ask, unless the setting lets this command through. */
  const commandApproval = (command: string) => (config.fairyCommands === 'auto' || (config.fairyCommands === 'readonly' && isReadOnlyCommand(command)) ? 'auto' as const : 'confirm' as const)
  const cwdOf = async (cwd?: string) => {
    if (!cwd) return workDir
    const dir = expandPath(cwd, workDir)
    const info = await stat(dir).catch(() => undefined)
    if (!info?.isDirectory()) throw new MushinError('not_found', `No folder ${dir}`)
    return dir
  }
  const sessionOf = (caller: { session?: string }) => (caller.session ? { session: caller.session } : {})

  const commandInput = z.object({
    command: z.string().trim().min(1).max(20_000).describe(`A command for ${resolveShell(config.shell)} on ${process.platform}`),
    cwd: z.string().optional().describe('Folder to run in; relative paths start at the working directory (the app folder unless set otherwise)'),
  })

  ctx.actions.define({
    name: 'terminal.run',
    description: `Run a command on this machine (${process.platform}, shell ${resolveShell(config.shell)}) and wait for it to finish: returns the exit code and output. For something that keeps running (a dev server, a watcher) use terminal.start. Runs in the app folder by default.`,
    risk: 'dangerous',
    input: commandInput.extend({
      timeout: z.number().int().min(1).max(600).default(60).describe('Seconds before the command is stopped, at most 600'),
      stdin: z.string().max(100_000).optional().describe('Text sent to the command\'s standard input'),
    }),
    approval: ({ command }) => commandApproval(command),
    handler: async ({ command, cwd, timeout, stdin }, caller) => {
      commandsOn()
      const dir = await cwdOf(cwd)
      const started = processes.start(command, { shell: config.shell, cwd: dir, ...sessionOf(caller) })
      if (stdin !== undefined) {
        processes.write(started.id, stdin)
      }
      processes.closeInput(started.id)
      const until = Date.now() + timeout * 1000
      let out = await processes.output(started.id, 0, 0)
      while (out?.running && Date.now() < until) out = await processes.output(started.id, out.next, Math.min(1000, until - Date.now()))
      let timedOut = false
      if (processes.get(started.id)?.running) {
        timedOut = true
        processes.stop(started.id)
        await processes.output(started.id, Number.MAX_SAFE_INTEGER, 3000)
      }
      const full = await processes.output(started.id, 0)
      const limit = config.maxOutput * 1024
      const text = full?.text ?? ''
      return {
        id: started.id,
        code: full?.code ?? null,
        output: plain(text.length > limit ? `…${text.slice(-limit)}` : text),
        ...(text.length > limit || (full?.from ?? 0) > 0 ? { truncated: true } : {}),
        ...(timedOut ? { timedOut: true, error: `Stopped after ${timeout} s; use terminal.start for commands that keep running` } : full?.error ? { error: full.error } : {}),
      }
    },
  })

  ctx.actions.define({
    name: 'terminal.start',
    description: 'Start a command that keeps running, such as a dev server or a watcher, and return its id at once. Read what it prints with terminal.output, send it input with terminal.write, and stop it with terminal.stop.',
    risk: 'dangerous',
    input: commandInput,
    approval: ({ command }) => commandApproval(command),
    handler: async ({ command, cwd }, caller) => {
      commandsOn()
      return processes.start(command, { shell: config.shell, cwd: await cwdOf(cwd), ...sessionOf(caller) })
    },
  })

  const idInput = z.object({ id: z.string().describe('Process id from terminal.start, terminal.run or terminal.processes') })
  const find = (id: string) => {
    const info = processes.get(id)
    if (!info) throw new MushinError('not_found', `No process ${id}; terminal.processes lists them`)
    return info
  }

  ctx.actions.define({
    name: 'terminal.output',
    description: 'What a started command printed, from offset `since` (0 for everything kept). Returns the text, `next` to pass as `since` next time, and whether it is still running with its exit code. `wait` waits up to that many seconds for new output, for example until a dev server says it is ready.',
    risk: 'read',
    input: idInput.extend({
      since: z.number().int().min(0).default(0),
      wait: z.number().min(0).max(30).default(0).describe('Seconds to wait for new output, at most 30'),
    }),
    handler: async ({ id, since, wait }) => {
      find(id)
      const out = (await processes.output(id, since, wait * 1000))!
      const limit = config.maxOutput * 1024
      return out.text.length > limit ? { ...out, text: plain(`…${out.text.slice(-limit)}`), truncated: true } : { ...out, text: plain(out.text) }
    },
  })

  ctx.actions.define({
    name: 'terminal.write',
    description: 'Send text to the standard input of a running command, such as an answer to its question. End a line with \\n.',
    risk: 'dangerous',
    input: idInput.extend({ text: z.string().max(100_000) }),
    approval: () => (config.fairyCommands === 'auto' ? 'auto' : 'confirm'),
    handler: ({ id, text }) => {
      commandsOn()
      if (!find(id).running) throw new MushinError('conflict', `Process ${id} has ended`)
      if (!processes.write(id, text)) throw new MushinError('conflict', `Process ${id} does not take input`)
      return { ok: true }
    },
  })

  ctx.actions.define({
    name: 'terminal.stop',
    description: 'Stop a running command and everything it started.',
    risk: 'write',
    input: idInput,
    handler: async ({ id }) => {
      find(id)
      processes.stop(id)
      await processes.output(id, Number.MAX_SAFE_INTEGER, 3000)
      return find(id)
    },
  })

  ctx.actions.define({
    name: 'terminal.processes',
    description: 'Commands run on this machine recently, newest first: id, command, folder, whether each is still running and its exit code.',
    risk: 'read',
    input: z.object({}),
    handler: () => processes.list(),
  })

  ctx.actions.define({
    name: 'terminal.processes.remove',
    description: 'Forget a finished command and its output.',
    risk: 'write',
    input: idInput,
    fairy: false,
    handler: ({ id }) => ({ removed: processes.remove(id) }),
  })

  // ---- files ----

  /** Writes in the plugin folders and the extra folders run; anywhere else in the app folder they ask first. */
  const writeApproval = (path: string) => {
    const target = resolve(baseDir, path)
    const ok = [...pluginDirs(), ...extraRoots].some((root) => !relative(root, target).startsWith('..') && !isAbsolute(relative(root, target)))
    return ok ? undefined : 'confirm' as const
  }

  ctx.actions.define({
    name: 'files.list',
    description: `List a folder in the app folder (${baseDir}), the plugin folders (plugins.folders) or the extra folders Fairy may use; depth up to 4 lists subfolders too (skipping node_modules, .git and dist). Paths are relative to the app folder; give other folders by absolute path.`,
    risk: 'read',
    input: z.object({
      path: z.string().default('.').describe('Folder, relative to the app folder'),
      depth: z.number().int().min(1).max(4).default(1),
    }),
    handler: ({ path, depth }) => {
      filesOn()
      return listFiles(fileRoots(), path, depth)
    },
  })

  ctx.actions.define({
    name: 'files.read',
    description: 'Read a text file, up to 2000 lines from `offset` (line number, from 1). Returns the lines and how many the file has. .env files are never readable.',
    risk: 'read',
    input: z.object({
      path: z.string().min(1),
      offset: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(2000).default(2000),
    }),
    handler: ({ path, offset, limit }) => {
      filesOn()
      return readText(fileRoots(), path, offset, limit)
    },
  })

  ctx.actions.define({
    name: 'files.search',
    description: 'Find lines matching a regular expression (case-insensitive) in the text files under a folder, skipping node_modules, .git, dist and data. `glob` narrows the files, e.g. "*.ts" or "plugins/**/*.ts".',
    risk: 'read',
    input: z.object({
      query: z.string().min(1),
      path: z.string().default('.'),
      glob: z.string().optional(),
      literal: z.boolean().default(false).describe('Search for the text as written, not as a regular expression'),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    handler: ({ query, path, glob, literal, limit }) => {
      filesOn()
      return searchFiles(fileRoots(), query, { path, glob, literal, limit })
    },
  })

  ctx.actions.define({
    name: 'files.write',
    description: 'Create or overwrite a text file with the given content, creating folders as needed. Prefer files.edit to change part of an existing file. In the plugin folders it runs at once; elsewhere it asks the user first.',
    risk: 'write',
    input: z.object({ path: z.string().min(1), content: z.string().max(1_000_000) }),
    approval: ({ path }) => writeApproval(path),
    handler: ({ path, content }) => {
      filesOn(true)
      return writeText(fileRoots(), path, content)
    },
  })

  ctx.actions.define({
    name: 'files.edit',
    description: 'Replace a piece of a text file: `old` must appear exactly once (copy it from files.read, with enough around it to be unique) unless `all` is true. In the plugin folders it runs at once; elsewhere it asks the user first.',
    risk: 'write',
    input: z.object({ path: z.string().min(1), old: z.string().min(1), new: z.string(), all: z.boolean().default(false) }),
    approval: ({ path }) => writeApproval(path),
    handler: ({ path, old, new: replacement, all }) => {
      filesOn(true)
      return editText(fileRoots(), path, old, replacement, all)
    },
  })
}
