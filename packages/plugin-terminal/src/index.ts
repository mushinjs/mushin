import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { type Context, field, type LocalizedText, z } from '@mushin/core'
import { FlowError, type NodeContext, type NodeResult, type NodeType, type PortDef } from '@mushin/plugin-flows'
import { type CommandResult, type LocalShell, quote, quotingOf, runLocal } from './shell'

export * from './shell'

export const name = 'terminal'
export const inject = ['flows']

const text = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })
const port = (name: string, type: PortDef['type'], en: string, zh: string): PortDef => ({ name, type, title: text(en, zh) })

const localShells = ['auto', 'powershell', 'pwsh', 'cmd', 'bash', 'sh'] as const

export const Config = z.object({
  local: z.boolean().default(true).meta(field('Allow local commands', 'Turn off to stop every Run command node', {
    'zh-CN': { title: '允许本地命令', description: '关闭后所有“运行命令”节点都不会执行' },
  }, { widget: 'switch' })),
  shell: z.enum(localShells).default('auto').meta(field('Local shell', 'auto: PowerShell on Windows, sh elsewhere', {
    'zh-CN': { title: '本地 Shell', description: 'auto：Windows 上为 PowerShell，其他系统为 sh' },
  })),
  cwd: z.string().default('').meta(field('Working directory', 'Where local commands run; empty uses the instance directory', {
    'zh-CN': { title: '工作目录', description: '本地命令的运行目录；留空使用实例目录' },
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
  env?: NodeJS.ProcessEnv
}

function expandPath(path: string, baseDir: string) {
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(baseDir, path)
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

/** The node types for one plugin config. */
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

  return [local]
}

export function apply(ctx: Context, config: Config) {
  for (const node of terminalNodes({ config, baseDir: ctx.baseDir ?? process.cwd() })) ctx.flows.defineNode(node)
}
