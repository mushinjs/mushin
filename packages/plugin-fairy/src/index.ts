import {
  type ActionInfo, Context, field, fromToolName, MushinError, randomId, segmentsToText, Service, toToolName, z,
} from '@mushinjs/core'
import { type Effort, EFFORTS, type LlmMessage, type LlmResult, type ToolCall, type ToolDefinition } from '@mushinjs/plugin-providers'
import type {} from '@mushinjs/plugin-storage'
import { contextNote, type SceneInfo, skillBlock, steerNote, SYSTEM_PROMPT, type TurnContext } from './prompt'
import {
  type FairySettings, defaultPolicy, formatSkillMarkdown, parseSkillMarkdown, policyInput, profileInput, SCENE_KEYS, type SceneProfile, today,
  type TokenUsage, type ToolPolicy,
} from './settings'
import { BUILTIN_ROLES, type FairyRole, type RoleDefinition, roleAllows, roleCalls, rolePrompt, type TaskReport, taskMessage } from './roles'
import { type FairySkill, BUILTIN_SKILLS, type SkillDefinition, skillFields, skillInput } from './skills'
import { type FairyRef, MAX_REFS, missingRef, readRef, refInput, refTags, type ShownRef } from './refs'

export * from './prompt'
export * from './refs'
export * from './roles'
export * from './settings'
export * from './skills'

declare module '@mushinjs/core' {
  interface Context {
    fairy: Fairy
  }

  interface Events {
    'fairy/event'(event: FairyEvent): void
    /** Skills, page profiles or tool policies changed. */
    'fairy/changed'(): void
    /** Conversations or their groups changed: titles, groups, done. */
    'fairy/sessions'(): void
  }
}

/**
 * `parent` and `call` are set on the events of a helper's conversation: the conversation that handed it the
 * task, and the id of that conversation's fairy__delegate call.
 */
export type FairyEvent = { session: string; parent?: string; call?: string } & (
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'tool-call'; id: string; action: string; input: unknown; risk: string }
  | { type: 'confirm'; id: string; action: string; input: unknown }
  /** An approval Fairy waited on was given: by the user, or by switching to a mode that does not ask for it. */
  | { type: 'confirmed'; id: string }
  | { type: 'tool-result'; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'done'; text: string; usage?: { inputTokens: number; outputTokens: number } }
  /** Something the user should know about a turn that still goes on; `effort_ignored`: the model ran without the picked effort. */
  | { type: 'notice'; code: 'effort_ignored' }
  /** `code` is `max_steps` when the turn ran out of tool rounds, so the dashboard can offer to go on. */
  | { type: 'error'; error: string; code?: 'max_steps' }
  /** The user wrote while the turn runs; Fairy reads it before its next step. */
  | { type: 'queued'; id: string; text: string }
  /** Messages written during the turn that Fairy (or a helper) has now read. */
  | { type: 'delivered'; ids: string[] }
)

/**
 * A stored message; `display` holds the user's own words when the content carries a context note,
 * and `skills` the names of the skills picked for it.
 */
export type FairyMessage = LlmMessage & {
  display?: string
  skills?: string[]
  /** A chat quoted into the message, as the dashboard shows it: who said what, and where. */
  quote?: QuotedChat
  /** What the user attached to the message (bots, flows, runs, log lines, …), as the message shows it. */
  refs?: ShownRef[]
  at: number
}

/** Messages of a bot's chat quoted into a Fairy message, around one picked message. */
export interface QuotedChat {
  bot: string
  botName: string
  channel: { type: 'group' | 'private'; id: string; name?: string }
  /** The picked message's record id; a sample for flows.test and flows.preview. */
  focus: string
  lines: { id: string; direction: 'in' | 'out'; user: string; userId: string; text: string; at: number }[]
}

/** Where a conversation was started, for the history list. */
export interface SessionScene {
  key: string
  label?: string
  page?: string
}

export interface FairySession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Tool list frozen at creation, so every request in the session sends identical tools. */
  tools: ToolDefinition[]
  messages: FairyMessage[]
  /** The page the conversation was started on. */
  scene?: SessionScene
  /** What it touched, for search: `scene:<key>`, `skill:<id>`, `command:<name>`, `resource:<kind>:<id>`, `role:<id>`. */
  tags?: string[]
  /** Set on a helper's conversation: the role it plays. */
  role?: string
  /** Set on a helper's conversation: the conversation and the fairy__delegate call that started it. */
  parent?: { session: string; call: string }
  /** The system prompt, frozen at creation like the tools; Fairy's own prompt when absent. */
  system?: string
  /** The group it is filed under. */
  group?: string
  /** Marked done: listed apart from the open conversations. */
  done?: boolean
}

/**
 * A group of conversations. Fairy files a conversation under the group of the first thing it works on
 * (a bot, a flow, a plugin, …), making the group when there is none; people make and rename groups too.
 */
export interface FairyGroup {
  id: string
  name: string
  /** What the group is about, e.g. `plugin:@mushinjs/plugin-weather` or `bot:<id>`; groups made by hand have none. */
  resource?: string
  /** The name in other languages, e.g. a plugin's display names. */
  labels?: Record<string, string>
  createdAt: number
}

export interface SendOptions {
  /** Dashboard connection id; client actions such as ui.navigate are routed back to it. */
  client?: string
  page?: string
  /** The page as the dashboard describes it; its hint and state go into the context note. */
  scene?: SceneInfo
  /** Ids of skills whose instructions go into this message. */
  skills?: string[]
  /** A message of a bot's chat to quote, with a few messages around it; the same as a `chat` reference. */
  quote?: { bot: string; channel: string; id: string; before?: number; after?: number }
  /** Things attached for Fairy to read with the message: bots, plugins, flows, runs, log lines, chat messages. */
  refs?: FairyRef[]
  /** Provider or profile, model and reasoning effort for this message; Fairy's settings when omitted. */
  provider?: string
  model?: string
  effort?: Effort
  /** Replaces the conversation from this user message on (0 is the first), to edit and resend it. */
  rewind?: number
  /** When Fairy asks before acting in this turn; `default` when omitted. See `APPROVAL_MODES`. */
  approvals?: ApprovalMode
}

/**
 * When Fairy asks before acting, picked next to the input: `ask` before anything that changes something;
 * `default` as the tool policies and plugins say (dangerous actions and commands ask); `auto` only before what
 * could do lasting harm (deleting, pushing, changing the system: `actions.risky`); `full` never. Tools turned off
 * stay off in every mode.
 */
export const APPROVAL_MODES = ['ask', 'default', 'auto', 'full'] as const
export type ApprovalMode = typeof APPROVAL_MODES[number]

/** Commands the dashboard runs itself, without asking the model. */
export const BUILTIN_COMMANDS = [
  { name: 'new', description: 'Start a new conversation', 'zh-CN': '开始新对话' },
  { name: 'history', description: 'Open the full conversation history', 'zh-CN': '打开完整历史' },
  { name: 'model', description: 'Switch Fairy\'s model', 'zh-CN': '切换模型' },
  { name: 'status', description: 'Show how much context this conversation uses', 'zh-CN': '查看上下文用量' },
  { name: 'help', description: 'Show what you can type', 'zh-CN': '查看可用的指令和技能' },
]

const SETTINGS_KEY = 'fairy/settings/main'
const USAGE_KEY = 'fairy/settings/usage'

const MAX_RESULT_CHARS = 16_000

export const Config = z.object({
  provider: z.string().optional().meta(field('Provider', 'Provider or model profile for Fairy; empty uses the default provider', {
    'zh-CN': { title: '提供商', description: 'Fairy 使用的提供商或配置方案；留空使用默认提供商' },
  }, { choices: 'providers.choices' })),
  model: z.string().optional().meta(field('Model', 'Model for Fairy; empty uses the provider\'s default', {
    'zh-CN': { title: '模型', description: 'Fairy 使用的模型；留空使用提供商默认模型' },
  })),
  effort: z.enum(EFFORTS as [Effort, ...Effort[]]).optional().meta(field('Reasoning effort', 'How much a reasoning model thinks; empty uses the model default', {
    'zh-CN': { title: '推理强度', description: '推理模型思考的程度；留空使用模型默认值' },
  })),
  maxSteps: z.number().int().min(1).max(50).default(20).meta(field('Max steps', 'Most tool-calling rounds in one reply', {
    'zh-CN': { title: '最大步数', description: '一次回复中最多调用工具的轮数' },
  })),
  confirmTimeout: z.number().int().min(10).default(600).meta(field('Approval timeout', 'Seconds to wait for approval of a dangerous action', {
    'zh-CN': { title: '确认超时', description: '等待用户批准危险操作的秒数' },
  })),
  dailyTokens: z.number().int().min(0).default(0).meta(field('Daily token budget', 'Input and output tokens Fairy may use per day; 0 means no limit', {
    'zh-CN': { title: '每日 Token 预算', description: 'Fairy 每天最多使用的输入和输出 Token；0 表示不限制' },
  })),
})

export type Config = z.infer<typeof Config>

interface Running {
  abort: AbortController
  confirms: Map<string, (approved: Approval) => void>
  /** Tokens of every request in this turn. */
  usage: { inputTokens: number; outputTokens: number }
  /** Failed calls per tool in this turn, to tell the model to stop guessing. */
  failures: Map<string, number>
  /** The user was told that the model ran without the picked effort. */
  effortIgnored?: boolean
  /** A helper's report, once it called fairy__report; the turn ends after that round. */
  report?: TaskReport
  /** ui.ask questions waiting for the user's answer. */
  asking?: number
  /** What the user wrote while the turn runs, read before the next step. */
  queue: Queued[]
  /** The approval mode, one object shared by a turn and the helpers it starts, so a switch reaches them all. */
  approvals: { mode: ApprovalMode }
  /** Calls waiting for approval, to ask again when the mode changes. */
  pending: Map<string, { name: string; input: unknown; risk: ActionInfo['risk'] }>
}

/** The user's answer to an approval: yes, no, or a message written instead. */
type Approval = boolean | 'replied'

/** A message the user sent while a turn was running. */
interface Queued {
  id: string
  text: string
  /** The message as the model reads it: a note that it came mid-turn, skills, a quoted chat, the text. */
  content: string
  skills?: string[]
  quote?: QuotedChat
  refs?: ShownRef[]
  at: number
}

function newRunning(approvals: { mode: ApprovalMode } = { mode: 'default' }): Running {
  return { abort: new AbortController(), confirms: new Map(), usage: { inputTokens: 0, outputTokens: 0 }, failures: new Map(), queue: [], approvals, pending: new Map() }
}

/** The turn used every tool round it may; the dashboard offers to continue. */
class StepLimit extends Error {
  constructor(steps: number) {
    super(`Stopped after ${steps} tool rounds; send another message to continue`)
  }
}

/** After this many failures of one tool in a turn, its errors ask the model to change course. */
const FAILURE_HINT_AFTER = 3

/** The most tools a request may carry: OpenAI refuses more than 128. */
export const MAX_TOOLS = 128
export const SEARCH_TOOL = 'search_tools'
export const CALL_TOOL = 'call_tool'
/** Hands a task to a helper role; only in Fairy's own conversations. */
export const DELEGATE_TOOL = 'fairy__delegate'
/** Ends a helper's task with its report; only in helpers' conversations. */
export const REPORT_TOOL = 'fairy__report'

/** Namespaces the system prompt names; they are listed first when not every tool fits. */
const CORE_NAMESPACES = ['ui', 'system', 'logs', 'commands', 'bots', 'flows', 'providers', 'plugins']

/**
 * Listing order when tools must be cut: the core namespaces and the tools of MCP servers the user connected
 * on purpose, then the other built-in tools.
 */
function toolTier(action: ActionInfo) {
  const namespace = action.name.split('.')[0]!
  if (CORE_NAMESPACES.includes(namespace)) return 0
  if (namespace === 'mcp' && !/^mcp\.(servers|tools)\./.test(action.name)) return 0
  return 1
}

/** Runs conversations in which the LLM operates Mushin.js through the action registry. */
export class Fairy extends Service {
  static inject = ['actions', 'llm', 'storage']
  static Config = Config

  private home: Context
  private running = new Map<string, Running>()
  private pluginSkills = new Map<string, FairySkill>()
  private pluginRoles = new Map<string, FairyRole>()
  /** Helper conversations that are running, with the conversation and call that started them. */
  private links = new Map<string, { session: string; call: string; parent: FairySession }>()
  /** Conversations with a turn running, as the turn holds them; changes from elsewhere go into these. */
  private live = new Map<string, FairySession>()
  private settingsCache?: FairySettings

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'fairy')
    this.home = ctx
  }

  *[Service.init]() {
    yield* this.defineActions()
    yield () => {
      for (const id of this.running.keys()) this.cancel(id)
    }
  }

  /** The actions the model may use: every one except Fairy's own and those turned off, core ones first. */
  private async allowedActions() {
    const settings = await this.settings()
    return this.home.actions.list()
      .filter((action) => action.fairy && !action.name.startsWith('fairy.') && this.policyOf(settings, action) !== 'off')
      .map((action, index) => ({ action, index }))
      .sort((a, b) => toolTier(a.action) - toolTier(b.action) || a.index - b.index)
      .map(({ action }) => action)
  }

  /**
   * Tools offered to the model. When there are more than a request may carry, the first ones are listed and
   * the rest are reached through search_tools and call_tool.
   */
  async tools(): Promise<ToolDefinition[]> {
    const actions = await this.allowedActions()
    const describe = (action: ActionInfo) => ({ name: toToolName(action.name), description: describeTool(action), parameters: portableSchema(action.inputSchema) })
    const delegate = this.delegateTool(actions)
    if (actions.length + 1 <= MAX_TOOLS) return [...actions.map(describe), delegate]
    return [
      ...actions.slice(0, MAX_TOOLS - 3).map(describe),
      delegate,
      {
        name: SEARCH_TOOL,
        description: `Find tools that are not listed here (${actions.length - MAX_TOOLS + 3} more, such as knowledge bases, personas and permissions) by words of what they do. Returns each tool's name, description and input schema; run one with ${CALL_TOOL}.`,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Words to look for in tool names and descriptions' },
            limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Most results (default 8)' },
          },
          required: ['query'],
        },
      },
      {
        name: CALL_TOOL,
        description: `Run a tool found with ${SEARCH_TOOL}, by its name and its input.`,
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Tool name, e.g. kb__search' },
            input: { type: 'object', description: 'The tool\'s input, matching its schema', additionalProperties: true },
          },
          required: ['name'],
        },
      },
    ]
  }

  /** Whether a role's needed actions are among the allowed ones, so it can do its job. */
  private roleReady(role: FairyRole, actions: Pick<ActionInfo, 'name'>[]) {
    return (role.needs ?? []).every((name) => actions.some((action) => action.name === name))
  }

  /** What keeps a role from working, for Fairy: the plugins to turn on, or the actions that are missing. */
  private roleMissing(role: FairyRole) {
    return role.enable?.length ? `turn on ${role.enable.join(', ')} first (plugins__enable), after asking the user` : `needs ${role.needs!.join(', ')}`
  }

  /** fairy__delegate, listing the roles; one that cannot work yet says what it needs, so Fairy can offer that. */
  private delegateTool(actions: ActionInfo[]): ToolDefinition {
    const roles = this.roles()
    return {
      name: DELEGATE_TOOL,
      description: [
        'Hand a task to a helper. It works in a conversation of its own with its own tools, and returns its report: status, summary, findings, changes and what to do next. Roles:',
        ...roles.map((role) => (this.roleReady(role, actions) ? `- ${role.id}: ${role.description}` : `- ${role.id} (not available yet: ${this.roleMissing(role)}): ${role.description}`)),
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: roles.map((role) => role.id) },
          task: { type: 'string', description: 'What to do, in the user\'s language: the goal, and what counts as done' },
          context: { type: 'string', description: 'What the helper should know: the page the user is on, ids you already have, what the user said or saw, what earlier helpers found' },
        },
        required: ['role', 'task'],
      },
    }
  }

  /**
   * The tools of a role's conversation: the actions it may use under the user's policies, call_tool when it may run
   * actions that come later, and fairy__report.
   */
  async roleTools(role: FairyRole): Promise<ToolDefinition[]> {
    const call = !!role.tools.call?.length
    const actions = (await this.allowedActions()).filter((action) => roleAllows(role, action)).slice(0, MAX_TOOLS - (call ? 2 : 1))
    return [
      ...actions.map((action) => ({ name: toToolName(action.name), description: describeTool(action), parameters: portableSchema(action.inputSchema) })),
      ...(call
        ? [{
            name: CALL_TOOL,
            description: `Run an action that is not listed here by its name and input, such as one of a plugin you just loaded (its actions did not exist when this task started). You may run ${role.tools.call!.join(' and ')} actions this way.`,
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Action name, e.g. weather.today or weather__today' },
                input: { type: 'object', description: 'The action\'s input', additionalProperties: true },
              },
              required: ['name'],
            },
          }]
        : []),
      {
        name: REPORT_TOOL,
        description: 'Finish the task and report to Fairy. Call it once, at the end.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['done', 'blocked', 'failed'], description: 'done; blocked: you need something only the user can give (say what in next); failed: it could not be done' },
            summary: { type: 'string', description: 'What you found or did, in a few sentences' },
            findings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  detail: { type: 'string' },
                  where: { type: 'string', description: 'Plugin package, bot id, flow id, provider id or file' },
                  evidence: { type: 'string', description: 'A log line or value you read' },
                  fix: { type: 'string', description: 'The fix you suggest' },
                },
                required: ['title'],
              },
            },
            changes: { type: 'array', items: { type: 'string' }, description: 'What you changed, one line each' },
            next: { type: 'string', description: 'What Fairy should do or ask the user next' },
          },
          required: ['status', 'summary'],
        },
      },
    ]
  }

  // ---- roles ----

  /** Adds a helper role from a plugin; removed when the plugin unloads. A plugin role replaces a built-in one with its id. */
  defineRole(definition: RoleDefinition) {
    const ctx = this.ctx
    const role: FairyRole = { ...definition, source: 'plugin', plugin: ctx.fiber.name }
    return ctx.effect(() => {
      this.pluginRoles.set(role.id, role)
      this.home.emit('fairy/changed')
      return () => {
        if (this.pluginRoles.get(role.id) === role) this.pluginRoles.delete(role.id)
        this.home.emit('fairy/changed')
      }
    }, `fairy.defineRole(${definition.id})`)
  }

  roles(): FairyRole[] {
    const byId = new Map<string, FairyRole>()
    for (const role of BUILTIN_ROLES) byId.set(role.id, { ...role, source: 'builtin' })
    for (const role of this.pluginRoles.values()) byId.set(role.id, role)
    return [...byId.values()]
  }

  role(id: string) {
    const role = this.roles().find((item) => item.id === id)
    if (!role) throw new MushinError('not_found', `No role "${id}"; roles: ${this.roles().map((item) => item.id).join(', ')}`)
    return role
  }

  /** Allowed tools matching some words, with their schemas, for search_tools. */
  async searchTools(query: string, limit = 8) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return (await this.allowedActions())
      .map((action) => {
        const name = action.name.toLowerCase()
        const text = `${name} ${action.plugin} ${action.description}`.toLowerCase()
        return { action, score: words.reduce((sum, word) => sum + (name.includes(word) ? 3 : 0) + (text.includes(word) ? 1 : 0), 0) }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(limit, 1), 20))
      .map(({ action }) => ({ name: toToolName(action.name), description: describeTool(action), inputSchema: portableSchema(action.inputSchema) }))
  }

  // ---- settings ----

  async settings(): Promise<FairySettings> {
    if (!this.settingsCache) {
      const saved = await this.home.storage.get<Partial<FairySettings>>(SETTINGS_KEY)
      this.settingsCache = { profiles: {}, toolPolicy: {}, disabledSkills: [], ...saved }
    }
    return this.settingsCache
  }

  private async updateSettings(change: (settings: FairySettings) => void) {
    const settings = await this.settings()
    change(settings)
    await this.home.storage.set(SETTINGS_KEY, settings)
    this.home.emit('fairy/changed')
    return settings
  }

  private policyOf(settings: FairySettings, action: Pick<ActionInfo, 'name' | 'risk'>): ToolPolicy {
    return settings.toolPolicy[action.name] ?? defaultPolicy(action.risk)
  }

  /** Every action with its policy, for the tool policy table. */
  async policies() {
    const settings = await this.settings()
    return this.home.actions.list()
      .filter((action) => action.fairy && !action.name.startsWith('fairy.'))
      .map((action) => ({
        name: action.name,
        description: action.description,
        plugin: action.plugin,
        risk: action.risk,
        client: action.client,
        policy: this.policyOf(settings, action),
        custom: action.name in settings.toolPolicy,
      }))
  }

  /** Sets the policy of some actions; `null` goes back to the default for the action's risk. */
  async setPolicy(changes: Record<string, ToolPolicy | null>) {
    await this.updateSettings((settings) => {
      for (const [name, policy] of Object.entries(changes)) {
        if (policy === null) delete settings.toolPolicy[name]
        else settings.toolPolicy[name] = policy
      }
    })
    return this.policies()
  }

  async profiles() {
    return (await this.settings()).profiles
  }

  async setProfile(scene: string, profile: SceneProfile | null) {
    const settings = await this.updateSettings((settings) => {
      if (profile === null) delete settings.profiles[scene]
      else settings.profiles[scene] = profile
    })
    return settings.profiles[scene] ?? {}
  }

  /** Tokens used today and the daily budget. */
  async usage() {
    const saved = await this.home.storage.get<TokenUsage>(USAGE_KEY)
    const used = saved?.day === today() ? saved : { day: today(), input: 0, output: 0 }
    return { ...used, budget: this.config.dailyTokens }
  }

  private async addUsage(usage: { inputTokens: number; outputTokens: number }) {
    const current = await this.usage()
    await this.home.storage.set(USAGE_KEY, { day: current.day, input: current.input + usage.inputTokens, output: current.output + usage.outputTokens })
  }

  private emit(event: FairyEvent) {
    const link = this.links.get(event.session)
    this.home.emit('fairy/event', link ? { ...event, parent: link.session, call: link.call } : event)
  }

  // ---- groups ----

  async groups(): Promise<FairyGroup[]> {
    const keys = await this.home.storage.list('fairy/groups')
    const groups = await Promise.all(keys.map((key) => this.home.storage.get<FairyGroup>(key)))
    return groups.filter((group): group is FairyGroup => !!group?.id).sort((a, b) => a.createdAt - b.createdAt)
  }

  async createGroup(input: { name: string; resource?: string; labels?: Record<string, string> }) {
    const group: FairyGroup = { id: randomId(8), name: input.name.trim().slice(0, 60), ...(input.resource ? { resource: input.resource } : {}), ...(input.labels ? { labels: input.labels } : {}), createdAt: Date.now() }
    await this.home.storage.set(`fairy/groups/${group.id}`, group)
    this.home.emit('fairy/sessions')
    return group
  }

  async updateGroup(id: string, patch: { name?: string }) {
    const group = (await this.groups()).find((item) => item.id === id)
    if (!group) throw new MushinError('not_found', `No group "${id}"`)
    // A renamed group keeps its name in every language.
    const next: FairyGroup = { ...group, ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 60), labels: undefined } : {}) }
    await this.home.storage.set(`fairy/groups/${id}`, next)
    this.home.emit('fairy/sessions')
    return next
  }

  /** Deletes a group; its conversations stay, ungrouped. */
  async deleteGroup(id: string) {
    for (const stored of await this.allSessions()) {
      const session = this.live.get(stored.id) ?? stored
      if (session.group !== id) continue
      session.group = undefined
      await this.home.storage.set(`fairy/${session.id}`, session)
    }
    await this.home.storage.delete(`fairy/groups/${id}`)
    this.home.emit('fairy/sessions')
    return { deleted: id }
  }

  /** Renames a conversation, files it under a group (null: none), or marks it done. */
  async updateSession(id: string, patch: { title?: string; group?: string | null; done?: boolean }) {
    const session = this.live.get(id) ?? await this.session(id)
    if (patch.group && !(await this.groups()).some((group) => group.id === patch.group)) throw new MushinError('not_found', `No group "${patch.group}"`)
    if (patch.title?.trim()) session.title = patch.title.trim().slice(0, 80)
    if (patch.group !== undefined) session.group = patch.group ?? undefined
    if (patch.done !== undefined) session.done = patch.done || undefined
    // Keep the order of the list: a rename or a move is not new activity.
    await this.home.storage.set(`fairy/${session.id}`, session)
    this.home.emit('fairy/sessions')
    return this.summary(session)
  }

  /** A readable name for a resource, and its names in other languages, for a new group. */
  private async resourceName(resource: string): Promise<{ name: string; labels?: Record<string, string> }> {
    const [kind, ...rest] = resource.split(':')
    const id = rest.join(':')
    const read = async (action: string, input: unknown) => {
      try {
        return await this.home.actions.call(action, input, { kind: 'internal' }) as any
      } catch {
        return undefined
      }
    }
    if (kind === 'plugin') {
      const entry = ((await read('plugins.catalog', { query: id })) as any[] | undefined)?.find((item) => item.package === id)
      const labels = entry?.manifest?.displayName as Record<string, string> | undefined
      return { name: labels?.en ?? id.replace(/^@[^/]+\//, ''), ...(labels ? { labels } : {}) }
    }
    if (kind === 'bot') return { name: (await read('bots.get', { id }))?.name ?? id }
    if (kind === 'flow') return { name: (await read('flows.get', { id }))?.name ?? id }
    if (kind === 'provider') return { name: ((await read('providers.list', {})) as any[] | undefined)?.find((item) => item.id === id)?.name ?? id }
    if (kind === 'kb') return { name: (await read('kb.get', { id }))?.name ?? ((await read('kb.list', {})) as any[] | undefined)?.find?.((item: any) => item.id === id)?.name ?? id }
    return { name: id }
  }

  /**
   * Notes what a successful call worked on as a `resource:` tag, and files a conversation that has no group
   * under that resource's group, making it when needed. A helper files the conversation that started it.
   */
  private async noteResource(session: FairySession, action: string, input: any, result: any) {
    const resource = resourceOf(action, input, result, (id) => this.home.manager?.entries.find((entry: { id: string }) => entry.id === id)?.package)
    if (!resource) return
    const tag = `resource:${resource}`
    if (!session.tags?.includes(tag)) session.tags = [...session.tags ?? [], tag]
    const target = session.parent ? this.links.get(session.id)?.parent : session
    if (!target || target.group || target.parent) return
    if (!target.tags?.includes(tag)) target.tags = [...target.tags ?? [], tag]
    const groups = await this.groups()
    const group = groups.find((item) => item.resource === resource) ?? await this.createGroup({ resource, ...await this.resourceName(resource) })
    target.group = group.id
    await this.save(target)
    this.home.emit('fairy/sessions')
  }

  private async allSessions() {
    const keys = await this.home.storage.list('fairy')
    const sessions = await Promise.all(keys.map((key) => this.home.storage.get<FairySession>(key)))
    return sessions
      .filter((session): session is FairySession => !!session && Array.isArray(session.messages))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private summary({ id, title, createdAt, updatedAt, scene, tags, role, parent, group, done }: FairySession) {
    const waiting = this.waiting(id)
    return {
      id, title, createdAt, updatedAt, scene, tags: tags ?? [], running: this.running.has(id),
      ...(waiting ? { waiting } : {}),
      ...(role ? { role } : {}), ...(parent ? { parent } : {}), ...(group ? { group } : {}), ...(done ? { done } : {}),
    }
  }

  /** What a running conversation, or a helper it started, waits on the user for: an approval or an answer. */
  private waiting(id: string): 'confirm' | 'ask' | undefined {
    const turns = [this.running.get(id), ...[...this.links].filter(([, link]) => link.session === id).map(([child]) => this.running.get(child))]
    if (turns.some((turn) => turn?.confirms.size)) return 'confirm'
    if (turns.some((turn) => turn?.asking)) return 'ask'
    return undefined
  }

  /** Fairy's own conversations; a helper's conversation is reached from the task that started it. */
  async sessions() {
    return (await this.allSessions()).filter((session) => !session.parent).map((session) => this.summary(session))
  }

  /**
   * Conversations matching every tag (`scene:flowEditor`, `skill:<id>`, `status:running`, …) and
   * containing the query in the title or in what the user or Fairy wrote.
   */
  async search(options: { query?: string; tags?: string[]; limit?: number } = {}) {
    const query = options.query?.trim().toLowerCase()
    const results = []
    for (const session of await this.allSessions()) {
      if (session.parent) continue
      const summary = this.summary(session)
      const tags = [...summary.tags, `status:${summary.running ? 'running' : 'idle'}`]
      if (options.tags?.some((tag) => !tags.includes(tag))) continue
      let snippet: string | undefined
      if (query) {
        if (!session.title.toLowerCase().includes(query)) {
          const texts = session.messages
            .filter((message) => message.role === 'user' || message.role === 'assistant')
            .map((message) => (message.role === 'user' ? message.display ?? message.content : message.content))
          const hit = texts.find((text): text is string => typeof text === 'string' && text.toLowerCase().includes(query))
          if (!hit) continue
          const at = hit.toLowerCase().indexOf(query)
          snippet = `${at > 30 ? '…' : ''}${hit.slice(Math.max(0, at - 30), at + query.length + 50).replace(/\s+/g, ' ')}`
        }
      }
      results.push({ ...summary, ...(snippet ? { snippet } : {}) })
      if (results.length >= (options.limit ?? 50)) break
    }
    return results
  }

  // ---- skills ----

  /** Adds a skill from a plugin; removed when the plugin unloads. */
  defineSkill(definition: SkillDefinition) {
    const ctx = this.ctx
    const skill: FairySkill = { ...definition, source: 'plugin', plugin: ctx.fiber.name, enabled: true }
    return ctx.effect(() => {
      this.pluginSkills.set(skill.id, skill)
      return () => {
        if (this.pluginSkills.get(skill.id) === skill) this.pluginSkills.delete(skill.id)
      }
    }, `fairy.defineSkill(${definition.id})`)
  }

  /** Built-in, plugin and user skills; user skills win on the same id. */
  async skills(): Promise<FairySkill[]> {
    const disabled = new Set((await this.settings()).disabledSkills)
    const byId = new Map<string, FairySkill>()
    for (const skill of BUILTIN_SKILLS) byId.set(skill.id, { ...skill, source: 'builtin', enabled: true })
    for (const skill of this.pluginSkills.values()) byId.set(skill.id, { ...skill })
    const keys = await this.home.storage.list('fairy/skills')
    for (const skill of await Promise.all(keys.map((key) => this.home.storage.get<FairySkill>(key)))) {
      if (skill?.id) byId.set(skill.id, { ...skill, source: 'user', enabled: skill.enabled !== false })
    }
    return [...byId.values()].map((skill) => (skill.source !== 'user' && disabled.has(skill.id) ? { ...skill, enabled: false } : skill))
  }

  async skill(id: string) {
    const skill = (await this.skills()).find((item) => item.id === id)
    if (!skill) throw new MushinError('not_found', `No skill "${id}"`)
    return skill
  }

  /** Saves a user skill. With the id of a built-in or plugin skill it replaces that one until deleted. */
  async saveSkill(input: SkillDefinition & { enabled?: boolean }) {
    const skill: FairySkill = { ...input, source: 'user', enabled: input.enabled !== false }
    await this.home.storage.set(`fairy/skills/${skill.id}`, skill)
    this.home.emit('fairy/changed')
    return this.skill(skill.id)
  }

  async createSkill(input: Omit<SkillDefinition, 'id'> & { id?: string }) {
    const taken = new Set((await this.skills()).map((skill) => skill.id))
    let id = input.id ?? (input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || randomId(6).toLowerCase())
    if (taken.has(id) && !input.id) id = `${id}-${randomId(4).toLowerCase()}`
    else if (taken.has(id)) throw new MushinError('conflict', `A skill with id "${id}" already exists`)
    return this.saveSkill({ ...input, id })
  }

  async updateSkill(id: string, patch: Partial<Omit<SkillDefinition, 'id'>>) {
    const current = await this.skill(id)
    const { source, plugin, enabled, ...rest } = current
    return this.saveSkill({ ...rest, ...patch, id, enabled })
  }

  /** Deletes a user skill; a built-in or plugin skill it replaced comes back. */
  async deleteSkill(id: string) {
    const current = await this.skill(id)
    if (current.source !== 'user') throw new MushinError('forbidden', 'Built-in and plugin skills cannot be deleted; turn them off instead')
    await this.home.storage.delete(`fairy/skills/${id}`)
    this.home.emit('fairy/changed')
    return { deleted: id, restored: (await this.skills()).some((skill) => skill.id === id) }
  }

  async setSkillEnabled(id: string, enabled: boolean) {
    const current = await this.skill(id)
    if (current.source === 'user') {
      await this.home.storage.set(`fairy/skills/${id}`, { ...current, enabled })
      this.home.emit('fairy/changed')
      return this.skill(id)
    }
    await this.updateSettings((settings) => {
      settings.disabledSkills = enabled ? settings.disabledSkills.filter((item) => item !== id) : [...new Set([...settings.disabledSkills, id])]
    })
    return this.skill(id)
  }

  /** Fairy commands and the commands of every bot, for the `/` picker. */
  commands() {
    const bots = this.home.get('bots')
    const names = new Map<string, string>((bots?.list() ?? []).map((bot: { id: string; name: string }) => [bot.id, bot.name]))
    const listed = bots?.commandList().commands ?? []
    return {
      builtin: BUILTIN_COMMANDS,
      bots: listed.filter((entry: { hidden?: boolean }) => !entry.hidden).map((entry: any) => ({
        name: entry.name,
        description: entry.description,
        usage: entry.usage,
        permission: entry.permission ?? entry.role,
        bot: entry.botId,
        botName: names.get(entry.botId),
        source: entry.source,
      })),
    }
  }

  async session(id: string) {
    const session = await this.home.storage.get<FairySession>(`fairy/${id}`)
    if (!session) throw new MushinError('not_found', `No Fairy session "${id}"`)
    return session
  }

  async createSession(): Promise<FairySession> {
    const now = Date.now()
    const session: FairySession = { id: randomId(), title: '', createdAt: now, updatedAt: now, tools: await this.tools(), messages: [] }
    await this.save(session)
    return session
  }

  /** Deletes a conversation and the conversations of the helpers it started. */
  async deleteSession(id: string) {
    this.cancel(id)
    for (const session of await this.allSessions()) {
      if (session.parent?.session === id) await this.deleteSession(session.id)
    }
    await this.home.storage.delete(`fairy/${id}`)
    return { deleted: id }
  }

  private save(session: FairySession) {
    session.updatedAt = Date.now()
    return this.home.storage.set(`fairy/${session.id}`, session)
  }

  private turnContext(page?: string, scene?: SceneInfo): TurnContext {
    const providers = this.home.llm.list()
    const bots = this.home.get('bots')?.list() ?? []
    return {
      page,
      scene,
      providers: providers.length,
      ready: this.home.llm.isReady(),
      bots: bots.length,
      online: bots.filter((bot: { status: string }) => bot.status === 'online').length,
    }
  }

  /** A bot's chat around one message, for quoting into a Fairy message. */
  private async quoteChat(input: NonNullable<SendOptions['quote']>): Promise<QuotedChat> {
    const bots = this.home.get('bots')
    if (!bots) throw new MushinError('unavailable', 'Quoting a chat needs the bots plugin')
    const record = bots.get(input.bot)
    const list = await bots.messages(input.bot, { channel: input.channel, limit: 300 })
    const index = list.findIndex((item) => item.id === input.id)
    if (index < 0) throw new MushinError('not_found', 'That message is no longer in the chat\'s recent messages')
    const picked = list.slice(Math.max(0, index - (input.before ?? 6)), index + 1 + (input.after ?? 2))
    return {
      bot: input.bot,
      botName: record.name,
      channel: { type: list[index].channel.type, id: list[index].channel.id, ...(list[index].channel.name ? { name: list[index].channel.name } : {}) },
      focus: input.id,
      lines: picked.map((item) => ({
        id: item.id,
        direction: item.direction,
        user: item.user.name ?? item.user.id,
        userId: item.user.id,
        text: segmentsToText(item.segments).trim().slice(0, 500),
        at: item.timestamp,
      })),
    }
  }

  /**
   * What the user attached to a message, read now: the blocks the model reads, the references the message shows,
   * and the first quoted chat. One that cannot be read says why instead of failing the message.
   */
  private async attachments(options: SendOptions) {
    const all: FairyRef[] = [...(options.quote ? [{ kind: 'chat' as const, ...options.quote }] : []), ...options.refs ?? []].slice(0, MAX_REFS)
    let quote: QuotedChat | undefined
    const read = await Promise.all(all.map(async (ref) => {
      try {
        if (ref.kind !== 'chat') return await readRef(this.home, ref)
        const chat = await this.quoteChat(ref)
        quote ??= chat
        const focus = chat.lines.find((line) => line.id === chat.focus)
        return { block: quoteBlock(chat), shown: { kind: 'chat', id: ref.id, label: ref.label || (focus ? `${focus.user}：${focus.text.slice(0, 40)}` : chat.channel.name ?? chat.channel.id) } as ShownRef }
      } catch (error) {
        return missingRef(ref, error)
      }
    }))
    return { blocks: read.map((item) => item.block), refs: read.map((item) => item.shown), quote }
  }

  /**
   * Starts a turn and returns once it finishes. Progress streams as `fairy/event` events. While a turn of the
   * conversation runs, the message joins it instead: Fairy reads it before its next step, and so does a helper
   * at work; an approval it waits for counts as declined. That call returns at once with `queued`.
   */
  async send(sessionId: string | undefined, text: string, options: SendOptions = {}) {
    if (!this.home.llm.list().length) {
      throw new MushinError('unavailable', 'Add an LLM provider before using Fairy')
    }
    const usage = await this.usage()
    if (usage.budget && usage.input + usage.output >= usage.budget) {
      throw new MushinError('unavailable', `Fairy used its daily budget of ${usage.budget} tokens; raise it in the Fairy settings or wait until tomorrow`)
    }
    const session = sessionId ? await this.session(sessionId) : await this.createSession()
    if (this.running.has(session.id)) {
      if (options.rewind !== undefined) throw new MushinError('conflict', 'Fairy is still working on this conversation; stop it before editing a message')
      if (options.approvals) await this.setApprovals(session.id, options.approvals)
      const queued = await this.steer(session.id, text, options)
      if (queued) return { session: session.id, queued }
      // The turn ended meanwhile: the message starts the next one.
    }
    if (options.rewind !== undefined) {
      let seen = -1
      const at = session.messages.findIndex((message) => message.role === 'user' && ++seen === options.rewind)
      if (at < 0) throw new MushinError('not_found', `This conversation has no user message ${options.rewind}`)
      session.messages = session.messages.slice(0, at)
    }
    // A conversation saved by an older version can hold more tools than a request may carry.
    if (session.tools.length > MAX_TOOLS) session.tools = session.role ? await this.roleTools(this.role(session.role)) : await this.tools()
    const running = newRunning({ mode: options.approvals ?? 'default' })
    this.running.set(session.id, running)
    this.live.set(session.id, session)
    const skills = options.skills?.length ? await Promise.all(options.skills.map((id) => this.skill(id))) : []
    const attached = await this.attachments(options)
    if (!session.title) session.title = (text || [...skills.map((skill) => skill.name), ...attached.refs.map((ref) => ref.label)].join(', ')).replace(/\s+/g, ' ').slice(0, 48)
    if (!session.messages.length && options.scene) {
      session.scene = { key: options.scene.key, ...(options.scene.label ? { label: options.scene.label } : {}), ...(options.page ? { page: options.page } : {}) }
    }
    session.tags = [...new Set([...session.tags ?? [], ...turnTags(text, options, skills)])]
    session.messages.push({
      role: 'user',
      content: [contextNote(this.turnContext(options.page, options.scene)), ...skills.map(skillBlock), ...attached.blocks, text].filter(Boolean).join('\n\n'),
      display: text,
      ...(skills.length ? { skills: skills.map((skill) => skill.name) } : {}),
      ...(attached.quote ? { quote: attached.quote } : {}),
      ...(attached.refs.length ? { refs: attached.refs } : {}),
      at: Date.now(),
    })
    await this.save(session)
    this.emit({ session: session.id, type: 'start' })
    try {
      let final = await this.loop(session, running, options)
      // A message that came in just as the reply ended still gets its answer.
      while (running.queue.length && !running.abort.signal.aborted) final = await this.loop(session, running, options)
      this.emit({ session: session.id, type: 'done', text: final?.text ?? '', usage: running.usage })
    } catch (error) {
      const message = running.abort.signal.aborted ? 'Stopped' : error instanceof Error ? error.message : String(error)
      this.emit({ session: session.id, type: 'error', error: message, ...(error instanceof StepLimit && !running.abort.signal.aborted ? { code: 'max_steps' as const } : {}) })
    } finally {
      // What the user wrote after a stop or failure stays in the conversation for the next turn.
      this.deliver(session, running)
      this.running.delete(session.id)
      this.live.delete(session.id)
      await this.save(session)
    }
    return { session: session.id }
  }

  private async loop(session: FairySession, running: Running, options: SendOptions) {
    let last: LlmResult | undefined
    for (let step = 0; step < this.config.maxSteps; step++) {
      // What the user wrote since the last step comes before the next request, after the tool results.
      this.deliver(session, running)
      const history: LlmMessage[] = [{ role: 'system', content: session.system ?? SYSTEM_PROMPT }, ...session.messages.map(stripMeta)]
      let result: LlmResult | undefined
      // A provider picked for this message comes with its own model choice, not Fairy's.
      const provider = options.provider ?? this.config.provider
      const model = options.provider ? options.model : options.model ?? this.config.model
      for await (const event of this.home.llm.stream({
        provider,
        model,
        ...(options.effort ?? this.config.effort ? { effort: options.effort ?? this.config.effort } : {}),
        messages: history,
        tools: session.tools.map((tool) => ({ ...tool, parameters: portableSchema(tool.parameters) })),
        signal: running.abort.signal,
      })) {
        if (event.type === 'delta') this.emit({ session: session.id, type: 'delta', text: event.text })
        else if (event.type === 'result') result = event.result
      }
      if (!result) throw new Error('The provider returned no result')
      last = result
      if (result.effortIgnored && !running.effortIgnored) {
        running.effortIgnored = true
        this.emit({ session: session.id, type: 'notice', code: 'effort_ignored' })
      }
      if (result.usage) {
        running.usage.inputTokens += result.usage.inputTokens
        running.usage.outputTokens += result.usage.outputTokens
        await this.addUsage(result.usage)
      }
      session.messages.push({
        role: 'assistant',
        content: result.text,
        ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
        ...(result.raw ? { raw: result.raw } : {}),
        at: Date.now(),
      })
      // A reply that would end the turn goes on when the user wrote meanwhile; the next step reads it.
      if (!result.toolCalls.length) {
        if (running.queue.length && !running.report && step < this.config.maxSteps - 1) continue
        return result
      }

      // A tool call cut off by the output limit, or in a refused turn, may be truncated: never run it.
      if (result.finishReason === 'length' || result.finishReason === 'refusal') {
        const reason = result.finishReason === 'length'
          ? 'The reply hit the output limit, so this tool call may be incomplete and was not run.'
          : 'The model declined this turn, so this tool call was not run.'
        for (const call of result.toolCalls) {
          session.messages.push({ role: 'tool', toolCallId: call.id, content: reason, isError: true, at: Date.now() })
        }
        throw new Error(reason)
      }

      for (const call of result.toolCalls) {
        await this.runTool(session, running, call, options)
      }
      if (running.report) return result
      // One round is left: ask for a summary instead of a turn that just stops mid-way.
      if (step === this.config.maxSteps - 2) {
        const last = session.messages.at(-1)!
        last.content += session.parent
          ? `\n\n[This was your last tool round (the limit is ${this.config.maxSteps}). Call only ${REPORT_TOOL} now: report what you found or did, and what is left.]`
          : `\n\n[This was the last tool round for this message (the limit is ${this.config.maxSteps}). Do not call tools now: tell the user what is done, what is left, and that they can send another message to continue.]`
      }
      await this.save(session)
    }
    throw new StepLimit(this.config.maxSteps)
  }

  private async runTool(session: FairySession, running: Running, call: ToolCall, options: SendOptions) {
    const reply = (content: string, isError = false) => {
      session.messages.push({ role: 'tool', toolCallId: call.id, content, ...(isError ? { isError } : {}), at: Date.now() })
    }

    let input: any
    try {
      input = JSON.parse(call.arguments || '{}')
    } catch {
      this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: false, error: 'Arguments are not valid JSON' })
      return reply('The arguments were not valid JSON. Send a JSON object that matches the tool schema.', true)
    }

    if (call.name === DELEGATE_TOOL && !session.parent) {
      this.emit({ session: session.id, type: 'tool-call', id: call.id, action: 'fairy.delegate', input, risk: 'write' })
      let report: Awaited<ReturnType<Fairy['delegate']>>
      try {
        report = await this.delegate(session, running, call.id, input, options)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: false, error: message })
        return reply(`Error: ${message}`, true)
      }
      this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: report.status !== 'failed', result: report, ...(report.status === 'failed' ? { error: report.summary } : {}) })
      return reply(truncate(JSON.stringify(report)), report.status === 'failed')
    }
    if (call.name === REPORT_TOOL && session.parent) {
      const report = parseReport(input)
      running.report = report
      this.emit({ session: session.id, type: 'tool-call', id: call.id, action: 'fairy.report', input, risk: 'read' })
      this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: true, result: { ok: true } })
      return reply('Report sent to Fairy.')
    }
    if (call.name === SEARCH_TOOL) {
      const found = await this.searchTools(String(input?.query ?? ''), Number(input?.limit) || 8)
      this.emit({ session: session.id, type: 'tool-call', id: call.id, action: SEARCH_TOOL, input, risk: 'read' })
      this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: true, result: { tools: found.map((tool) => tool.name) } })
      return reply(truncate(JSON.stringify(found.length ? { tools: found } : { tools: [], hint: 'Nothing matched; try other words.' })))
    }
    // A tool reached through call_tool runs exactly like a listed one, with the same policy.
    let toolName = call.name
    if (call.name === CALL_TOOL) {
      toolName = typeof input?.name === 'string' ? input.name : ''
      input = input?.input ?? {}
    }
    const name = toolName.includes('.') ? toolName : fromToolName(toolName)
    const info = this.home.actions.get(name)
    if (!info || !info.fairy) {
      this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: false, error: `Unknown tool ${toolName}` })
      return reply(`The tool ${toolName} is not available right now.`, true)
    }

    // A helper keeps to its role's tools, whatever name it sends.
    if (session.parent) {
      const role = this.roles().find((item) => item.id === session.role)
      if (!role || !(call.name === CALL_TOOL ? roleCalls(role, info) : roleAllows(role, info))) {
        this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: false, error: `Not a tool of this helper: ${toolName}` })
        return reply(`${toolName} is not one of your tools. Report what you need instead.`, true)
      }
    }

    const settings = await this.settings()
    const policy = this.policyFor(settings, info, input, running.approvals.mode)
    if (policy === 'off') {
      this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: false, error: 'Turned off in the Fairy settings' })
      return reply(`The user turned ${toolName} off for Fairy. Do not use it; tell them if it is needed.`, true)
    }

    this.emit({ session: session.id, type: 'tool-call', id: call.id, action: name, input, risk: info.risk })

    if (policy === 'confirm') {
      this.emit({ session: session.id, type: 'confirm', id: call.id, action: name, input })
      running.pending.set(call.id, { name, input, risk: info.risk })
      const approved = await this.waitForApproval(running, call.id).finally(() => running.pending.delete(call.id))
      if (approved === true) this.emit({ session: session.id, type: 'confirmed', id: call.id })
      if (approved !== true) {
        this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: false, error: 'Declined by the user' })
        return reply(approved === 'replied'
          ? 'The user did not approve this; they wrote a message instead, which follows. Go by what it says.'
          : 'The user declined this action. Do not retry it.', true)
      }
    }

    if (name === 'ui.ask') running.asking = (running.asking ?? 0) + 1
    try {
      const result = await this.home.actions.call(name, input, { kind: 'fairy', session: session.id, client: options.client })
      this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: true, result })
      await this.noteResource(session, name, input, result).catch((error) => this.ctx.logger.warn('could not file the conversation: %s', error))
      reply(truncate(JSON.stringify(result ?? { ok: true })))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: false, error: message })
      const failures = (running.failures.get(name) ?? 0) + 1
      running.failures.set(name, failures)
      const hint = failures >= FAILURE_HINT_AFTER
        ? `\n${toolName} has failed ${failures} times in this reply. Stop retrying it with guessed inputs: take valid values from the error above or from the tool that lists them, or tell the user what is missing.`
        : ''
      reply(`Error: ${message}${hint}`, true)
    } finally {
      if (name === 'ui.ask') running.asking = (running.asking ?? 1) - 1
    }
  }

  /**
   * Runs a helper on a task in a conversation of its own and returns its report. The helper uses the model
   * of the turn that started it, stops when that turn stops, and its tokens count toward that turn.
   */
  private async delegate(parent: FairySession, parentRunning: Running, callId: string, input: any, options: SendOptions) {
    const role = this.role(String(input?.role ?? ''))
    const task = typeof input?.task === 'string' ? input.task.trim() : ''
    if (!task) throw new MushinError('invalid_input', 'Say what the helper should do in task')
    if (!this.roleReady(role, await this.allowedActions())) {
      const fix = role.enable?.length
        ? `Ask the user whether to turn on ${role.enable.join(', ')}, saying what it lets you do; when they agree, turn it on with plugins__enable and delegate again`
        : 'A plugin that adds them is off, or the tools are turned off for Fairy in its settings'
      throw new MushinError('unavailable', `The ${role.name} helper cannot work yet: it needs ${role.needs!.join(', ')}. ${fix}.`)
    }
    const now = Date.now()
    const child: FairySession = {
      id: randomId(),
      title: task.replace(/\s+/g, ' ').slice(0, 48),
      createdAt: now,
      updatedAt: now,
      tools: await this.roleTools(role),
      system: rolePrompt(role),
      role: role.id,
      parent: { session: parent.id, call: callId },
      tags: [`role:${role.id}`],
      messages: [{ role: 'user', content: taskMessage(task, typeof input?.context === 'string' ? input.context : undefined, new Date(now)), display: task, at: now }],
    }
    const running = newRunning(parentRunning.approvals)
    const stop = () => running.abort.abort()
    parentRunning.abort.signal.addEventListener('abort', stop, { once: true })
    this.running.set(child.id, running)
    this.live.set(child.id, child)
    this.links.set(child.id, { ...child.parent!, parent })
    await this.save(child)
    this.emit({ session: child.id, type: 'start' })
    let report: TaskReport
    try {
      const final = await this.loop(child, running, { provider: options.provider, model: options.model, effort: options.effort })
      report = running.report ?? { status: 'done', summary: final?.text || 'The helper finished without a report.' }
      this.emit({ session: child.id, type: 'done', text: report.summary, usage: running.usage })
    } catch (error) {
      const message = running.abort.signal.aborted ? 'Stopped' : error instanceof Error ? error.message : String(error)
      report = running.report ?? { status: 'failed', summary: message }
      this.emit({ session: child.id, type: 'error', error: message, ...(error instanceof StepLimit && !running.abort.signal.aborted ? { code: 'max_steps' as const } : {}) })
    } finally {
      // The conversation that started the helper has the same messages and reads them next.
      running.queue.length = 0
      parentRunning.abort.signal.removeEventListener('abort', stop)
      this.running.delete(child.id)
      this.live.delete(child.id)
      this.links.delete(child.id)
      parentRunning.usage.inputTokens += running.usage.inputTokens
      parentRunning.usage.outputTokens += running.usage.outputTokens
      await this.save(child)
    }
    if (parentRunning.abort.signal.aborted) throw new Error('Stopped')
    return { task: child.id, role: role.id, ...report }
  }

  /**
   * Adds a message to the running turn of a conversation, and to the turns of helpers it has at work, which
   * read it before their next step. Approvals they wait for count as declined, since the user wrote instead.
   */
  private async steer(sessionId: string, text: string, options: SendOptions) {
    const skills = options.skills?.length ? await Promise.all(options.skills.map((id) => this.skill(id))) : []
    const attached = await this.attachments(options)
    const running = this.running.get(sessionId)
    if (!running) return undefined
    const id = randomId()
    const helpers = [...this.links].filter(([child, link]) => link.session === sessionId && this.running.has(child)).map(([child]) => this.running.get(child)!)
    const item = (note: string): Queued => ({
      id,
      text,
      content: [note, ...skills.map(skillBlock), ...attached.blocks, text].filter(Boolean).join('\n\n'),
      ...(skills.length ? { skills: skills.map((skill) => skill.name) } : {}),
      ...(attached.quote ? { quote: attached.quote } : {}),
      ...(attached.refs.length ? { refs: attached.refs } : {}),
      at: Date.now(),
    })
    running.queue.push(item(steerNote(helpers.length ? 'helper-told' : 'own')))
    for (const helper of helpers) helper.queue.push(item(steerNote('helper')))
    for (const turn of [running, ...helpers]) {
      for (const resolve of [...turn.confirms.values()]) resolve('replied')
    }
    this.emit({ session: sessionId, type: 'queued', id, text })
    return id
  }

  /** Puts what the user wrote during the turn into the conversation, where the next request reads it. */
  private deliver(session: FairySession, running: Running) {
    if (!running.queue.length) return
    const items = running.queue.splice(0)
    for (const item of items) {
      session.messages.push({
        role: 'user',
        content: item.content,
        display: item.text,
        ...(item.skills ? { skills: item.skills } : {}),
        ...(item.quote ? { quote: item.quote } : {}),
        ...(item.refs ? { refs: item.refs } : {}),
        at: item.at,
      })
    }
    this.emit({ session: session.id, type: 'delivered', ids: items.map((item) => item.id) })
  }

  /** Resolves true or false with the user's answer, or `replied` when they wrote a message instead. */
  private waitForApproval(running: Running, callId: string) {
    return new Promise<Approval>((resolve) => {
      const timer = setTimeout(() => finish(false), this.config.confirmTimeout * 1000)
      const finish = (approved: Approval) => {
        clearTimeout(timer)
        running.confirms.delete(callId)
        resolve(approved)
      }
      running.confirms.set(callId, finish)
      running.abort.signal.addEventListener('abort', () => finish(false), { once: true })
    })
  }

  /**
   * Whether Fairy asks before a call in this mode. Tools turned off in the settings stay off; a tool set to ask
   * keeps asking unless everything is allowed.
   */
  private policyFor(settings: FairySettings, info: Pick<ActionInfo, 'name' | 'risk'>, input: unknown, mode: ApprovalMode): ToolPolicy {
    const set = settings.toolPolicy[info.name]
    if (set === 'off') return 'off'
    const policy = set ?? this.home.actions.approval(info.name, input) ?? defaultPolicy(info.risk)
    switch (mode) {
      case 'full':
        return 'auto'
      case 'auto':
        return set === 'confirm' || this.home.actions.risky(info.name, input) ? 'confirm' : 'auto'
      case 'ask':
        return info.risk === 'read' ? policy : 'confirm'
      default:
        return policy
    }
  }

  /**
   * Switches the approval mode of a running turn and the helpers it started. Calls waiting for approval that the
   * new mode would not ask for go ahead.
   */
  async setApprovals(sessionId: string, mode: ApprovalMode) {
    const running = this.running.get(sessionId)
    if (!running) return { ok: false }
    const shared = running.approvals
    shared.mode = mode
    const settings = await this.settings()
    for (const turn of this.running.values()) {
      if (turn.approvals !== shared) continue
      for (const [id, call] of turn.pending) {
        if (this.policyFor(settings, call, call.input, mode) === 'auto') turn.confirms.get(id)?.(true)
      }
    }
    return { ok: true }
  }

  confirm(sessionId: string, callId: string, approved: boolean) {
    const resolve = this.running.get(sessionId)?.confirms.get(callId)
    if (!resolve) throw new MushinError('not_found', 'No action is waiting for approval')
    resolve(approved)
    return { ok: true }
  }

  cancel(sessionId: string) {
    const running = this.running.get(sessionId)
    if (!running) return { ok: false }
    running.abort.abort()
    return { ok: true }
  }

  status() {
    return { ready: this.home.llm.isReady(), providers: this.home.llm.list().length, running: [...this.running.keys()] }
  }

  private *defineActions() {
    const actions = this.home.actions

    yield actions.define({
      name: 'fairy.status',
      description: 'Whether Fairy can run (a provider exists and passed its test).',
      risk: 'read',
      input: z.object({}),
      handler: () => this.status(),
    })

    yield actions.define({
      name: 'fairy.sessions',
      description: 'List Fairy conversations, newest first.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.sessions(),
    })

    yield actions.define({
      name: 'fairy.session',
      description: 'Get one Fairy conversation with its messages.',
      risk: 'read',
      input: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        const { tools, system, ...session } = await this.session(id)
        const role = session.role ? this.roles().find((item) => item.id === session.role) : undefined
        const now = new Set((role ? await this.roleTools(role) : await this.tools()).map((tool) => tool.name))
        const toolsStale = tools.length !== now.size || tools.some((tool) => !now.has(tool.name))
        return { ...session, messages: session.messages.map(({ raw, ...message }: any) => message), running: this.running.has(id), toolsStale }
      },
    })

    yield actions.define({
      name: 'fairy.send',
      description: 'Send a message to Fairy. Omit session to start a new conversation. Progress streams over the WebSocket.',
      risk: 'write',
      input: z.object({
        session: z.string().optional(),
        text: z.string(),
        page: z.string().optional(),
        scene: z.object({
          key: z.string(),
          label: z.string().max(200).optional(),
          hint: z.string().max(1000).optional(),
          state: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
          resource: z.string().max(200).optional(),
        }).optional().describe('The dashboard page as the dashboard describes it'),
        skills: z.array(z.string()).max(5).optional().describe('Skill ids to apply to this message'),
        quote: z.object({
          bot: z.string(),
          channel: z.string().describe('The chat\'s id'),
          id: z.string().describe('The quoted message\'s record id, from bots.messages'),
          before: z.number().int().min(0).max(30).optional(),
          after: z.number().int().min(0).max(10).optional(),
        }).optional().describe('A message of a bot\'s chat to quote, with a few messages around it'),
        refs: z.array(refInput).max(MAX_REFS).optional().describe('Things to attach for Fairy to read: bots, plugins, flows, runs, log lines, chat messages'),
        provider: z.string().optional().describe('Provider or profile id for this message; Fairy\'s setting when omitted'),
        model: z.string().optional().describe('Model for this message; Fairy\'s setting or the provider\'s default when omitted'),
        effort: z.enum(EFFORTS as [Effort, ...Effort[]]).optional().describe('Reasoning effort for this message'),
        rewind: z.number().int().min(0).optional().describe('Edit: drop the conversation from this user message on (0 is the first) and send text in its place'),
        approvals: z.enum(APPROVAL_MODES).optional().describe('When Fairy asks before acting: ask (before any change), default, auto (only before lasting harm), full (never)'),
      }).refine((input) => input.text.trim() || input.skills?.length || input.refs?.length || input.quote, 'Send some text, pick a skill or attach something'),
      handler: ({ session, text, ...options }, caller) => this.send(session, text, { client: caller.client, ...options }),
    })

    yield actions.define({
      name: 'fairy.search',
      description: 'Search Fairy conversations by text and tags (scene:<page kind>, skill:<id>, command:<name>, resource:<kind>:<id>, status:running).',
      risk: 'read',
      input: z.object({ query: z.string().optional(), tags: z.array(z.string()).optional(), limit: z.number().int().min(1).max(200).optional() }),
      handler: (input) => this.search(input),
    })

    yield actions.define({
      name: 'fairy.commands',
      description: 'Commands for Fairy\'s "/" picker: its own (new, history, …) and every bot\'s commands.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.commands(),
    })

    yield actions.define({
      name: 'fairy.skills.list',
      description: 'List Fairy\'s skills: built in, from plugins, and written by the user.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.skills(),
    })

    yield actions.define({
      name: 'fairy.skills.get',
      description: 'Get one Fairy skill with its instructions.',
      risk: 'read',
      input: z.object({ id: z.string() }),
      handler: ({ id }) => this.skill(id),
    })

    const skillId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).describe('Lowercase letters, digits and dashes')

    yield actions.define({
      name: 'fairy.skills.create',
      description: 'Create a user skill. Omit id to make one from the name.',
      risk: 'write',
      input: skillInput.extend({ id: skillId.optional() }),
      handler: (input) => this.createSkill(input),
    })

    yield actions.define({
      name: 'fairy.skills.update',
      description: 'Change a skill. Changing a built-in or plugin skill saves your own copy that replaces it until deleted.',
      risk: 'write',
      input: z.object({
        id: z.string(),
        name: skillFields.name.optional(),
        description: z.string().trim().max(300).optional(),
        instructions: skillFields.instructions.optional(),
        whenToUse: skillFields.whenToUse,
        tools: skillFields.tools,
        scenes: skillFields.scenes,
      }),
      handler: ({ id, ...patch }) => this.updateSkill(id, patch),
    })

    yield actions.define({
      name: 'fairy.skills.delete',
      description: 'Delete a user skill. A built-in or plugin skill it replaced comes back.',
      risk: 'write',
      input: z.object({ id: z.string() }),
      handler: ({ id }) => this.deleteSkill(id),
    })

    yield actions.define({
      name: 'fairy.skills.setEnabled',
      description: 'Turn a skill on or off; off skills are not offered with $.',
      risk: 'write',
      input: z.object({ id: z.string(), enabled: z.boolean() }),
      handler: ({ id, enabled }) => this.setSkillEnabled(id, enabled),
    })

    yield actions.define({
      name: 'fairy.skills.import',
      description: 'Import a skill from a SKILL.md file (YAML frontmatter with name and description, then Markdown instructions), as used by Claude and Codex skills.',
      risk: 'write',
      input: z.object({ markdown: z.string().min(1).max(40_000), replace: z.boolean().optional().describe('Overwrite a skill with the same id') }),
      handler: async ({ markdown, replace }) => {
        let parsed: ReturnType<typeof parseSkillMarkdown>
        try {
          parsed = parseSkillMarkdown(markdown)
        } catch (error) {
          throw new MushinError('invalid_input', error instanceof Error ? error.message : String(error))
        }
        const input = skillInput.extend({ id: skillId.optional() }).parse(parsed)
        if (replace && input.id) return this.saveSkill({ ...input, id: input.id })
        return this.createSkill(input)
      },
    })

    yield actions.define({
      name: 'fairy.skills.export',
      description: 'A skill as a SKILL.md file.',
      risk: 'read',
      input: z.object({ id: z.string() }),
      handler: async ({ id }) => ({ fileName: 'SKILL.md', markdown: formatSkillMarkdown(await this.skill(id)) }),
    })

    yield actions.define({
      name: 'fairy.groups.list',
      description: 'Groups of Fairy conversations. Fairy files a conversation under the group of the first bot, flow, plugin, provider or knowledge base it works on.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.groups(),
    })

    yield actions.define({
      name: 'fairy.groups.create',
      description: 'Make a group of Fairy conversations.',
      risk: 'write',
      input: z.object({ name: z.string().trim().min(1).max(60) }),
      handler: ({ name }) => this.createGroup({ name }),
    })

    yield actions.define({
      name: 'fairy.groups.update',
      description: 'Rename a group of Fairy conversations.',
      risk: 'write',
      input: z.object({ id: z.string(), name: z.string().trim().min(1).max(60) }),
      handler: ({ id, name }) => this.updateGroup(id, { name }),
    })

    yield actions.define({
      name: 'fairy.groups.delete',
      description: 'Delete a group of Fairy conversations; the conversations stay, ungrouped.',
      risk: 'write',
      input: z.object({ id: z.string() }),
      handler: ({ id }) => this.deleteGroup(id),
    })

    yield actions.define({
      name: 'fairy.sessions.update',
      description: 'Rename a Fairy conversation, file it under a group (null takes it out of its group), or mark it done.',
      risk: 'write',
      input: z.object({ id: z.string(), title: z.string().trim().min(1).max(80).optional(), group: z.string().nullable().optional(), done: z.boolean().optional() }),
      handler: ({ id, ...patch }) => this.updateSession(id, patch),
    })

    yield actions.define({
      name: 'fairy.roles.list',
      description: 'The helpers Fairy can hand tasks to, with what each is for and which tools it may use.',
      risk: 'read',
      input: z.object({}),
      handler: async () => {
        const allowed = await this.allowedActions()
        return Promise.all(this.roles().map(async (role) => ({
          ...role,
          ready: this.roleReady(role, allowed),
          toolNames: (await this.roleTools(role)).map((tool) => tool.name).filter((name) => name !== REPORT_TOOL),
        })))
      },
    })

    yield actions.define({
      name: 'fairy.profiles.list',
      description: 'What Fairy says and offers on each dashboard page, as the user changed it: hint, welcome line, own suggestions, hidden built-in suggestions, recommended skills.',
      risk: 'read',
      input: z.object({}),
      handler: async () => ({ scenes: SCENE_KEYS, profiles: await this.profiles() }),
    })

    yield actions.define({
      name: 'fairy.profiles.update',
      description: 'Change what Fairy says and offers on one dashboard page. Send the whole profile; null goes back to the defaults.',
      risk: 'write',
      input: z.object({ scene: z.enum(SCENE_KEYS), profile: profileInput.nullable() }),
      handler: ({ scene, profile }) => this.setProfile(scene, profile),
    })

    yield actions.define({
      name: 'fairy.policy.list',
      description: 'Every tool Fairy can use, with its plugin, risk and policy: auto (runs), confirm (asks the user first) or off (not offered).',
      risk: 'read',
      input: z.object({}),
      handler: () => this.policies(),
    })

    yield actions.define({
      name: 'fairy.policy.set',
      description: 'Set the policy of tools by action name: auto, confirm, or off; null goes back to the default (dangerous actions ask, others run). Off tools leave new conversations only.',
      risk: 'dangerous',
      input: z.object({ policies: z.record(z.string(), policyInput.nullable()) }),
      handler: ({ policies }) => this.setPolicy(policies),
    })

    yield actions.define({
      name: 'fairy.usage',
      description: 'Tokens Fairy used today and its daily budget (0 means no limit).',
      risk: 'read',
      input: z.object({}),
      handler: () => this.usage(),
    })

    yield actions.define({
      name: 'fairy.confirm',
      description: 'Approve or decline an action Fairy is waiting on.',
      risk: 'write',
      input: z.object({ session: z.string(), id: z.string(), approved: z.boolean() }),
      handler: ({ session, id, approved }) => this.confirm(session, id, approved),
    })

    yield actions.define({
      name: 'fairy.approvals',
      description: 'Switch when Fairy asks before acting, for the reply it is working on and the helpers it started: ask, default, auto or full. Waiting approvals the new mode does not ask for go ahead.',
      risk: 'write',
      input: z.object({ session: z.string(), mode: z.enum(APPROVAL_MODES) }),
      handler: ({ session, mode }) => this.setApprovals(session, mode),
    })

    yield actions.define({
      name: 'fairy.cancel',
      description: 'Stop Fairy\'s current reply in a conversation.',
      risk: 'write',
      input: z.object({ session: z.string() }),
      handler: ({ session }) => this.cancel(session),
    })

    yield actions.define({
      name: 'fairy.deleteSession',
      description: 'Delete a Fairy conversation.',
      risk: 'write',
      input: z.object({ id: z.string() }),
      handler: ({ id }) => this.deleteSession(id),
    })
  }
}

/**
 * A tool schema every provider accepts. OpenAI rejects regex patterns with Unicode property escapes such as
 * \p{L}; the action still checks its input with the full pattern, so the pattern is only dropped here.
 */
export function portableSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(portableSchema) as T
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'pattern' && typeof value === 'string' && /\\[pP]\{/.test(value)) continue
    out[key] = portableSchema(value)
  }
  return out as T
}

function describeTool(action: ActionInfo) {
  const notes: string[] = []
  if (action.risk === 'dangerous') notes.push('Dangerous: the user must approve it.')
  if (action.client) notes.push('Runs in the user\'s dashboard; fails if none is connected.')
  return [action.description, ...notes].join(' ')
}

/** Search tags for one message: its scene, skills, a leading command, and the page's resource. */
/** A quoted chat as the model reads it; the picked message is marked, with its record id for samples. */
function quoteBlock(quote: QuotedChat) {
  const where = quote.channel.type === 'group' ? `group ${quote.channel.name ? `${quote.channel.name} ` : ''}(${quote.channel.id})` : `private chat with ${quote.channel.id}`
  const lines = quote.lines.map((line) => {
    const time = new Date(line.at).toISOString().slice(11, 16)
    const who = line.direction === 'out' ? `${quote.botName} (bot)` : `${line.user} (${line.userId})`
    return `${line.id === quote.focus ? '→ ' : '  '}[${time}] ${who}: ${line.text}`
  })
  return [
    `<quote bot="${quote.bot}" chat="${quote.channel.id}" message="${quote.focus}">`,
    `Messages from ${quote.botName} in the ${where}; the user picked the one marked →. To build or check a flow for it, pass sample { bot: "${quote.bot}", id: "${quote.focus}", channel: "${quote.channel.id}" } to flows.test or flows.preview.`,
    ...lines,
    '</quote>',
  ].join('\n')
}

function turnTags(text: string, options: SendOptions, skills: FairySkill[]) {
  const tags: string[] = []
  if (options.scene) tags.push(`scene:${options.scene.key}`)
  if (options.scene?.resource) tags.push(`resource:${options.scene.resource}`)
  for (const skill of skills) tags.push(`skill:${skill.id}`)
  tags.push(...refTags(options.refs ?? []))
  const command = /^\s*\/([\p{L}\p{N}_-]+)/u.exec(text)
  if (command) tags.push(`command:${command[1]}`)
  return tags
}

/** Namespaces whose actions name one thing by id, and the kind of resource it is. */
const RESOURCE_KINDS: Record<string, string> = { bots: 'bot', flows: 'flow', providers: 'provider', kb: 'kb', personas: 'persona' }

/**
 * What an action worked on, as `<kind>:<id>`: the bot, flow, provider, knowledge base, persona or plugin package
 * it names in its input, or the one it made. `pluginOf` turns a plugin entry id into its package.
 */
export function resourceOf(action: string, input: any, result: any, pluginOf: (id: string) => string | undefined = () => undefined) {
  const [namespace, verb] = action.split('.')
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
  if (namespace === 'plugins') {
    const pkg = text(input?.package) ?? (text(input?.id) ? pluginOf(input.id) : undefined)
    return pkg ? `plugin:${pkg}` : undefined
  }
  if (namespace === 'bots' && action.startsWith('bots.plugins.')) {
    const pkg = text(input?.package)
    if (pkg) return `plugin:${pkg}`
  }
  const kind = RESOURCE_KINDS[namespace!]
  if (!kind) return undefined
  const id = text(input?.id) ?? text(input?.bot && namespace === 'bots' ? input.bot : undefined) ?? (verb === 'create' ? text(result?.id) : undefined)
  return id ? `${kind}:${id}` : undefined
}

/** A report as a helper sent it, with the fields Fairy reads; anything malformed is dropped. */
function parseReport(input: any): TaskReport {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
  const status = ['done', 'blocked', 'failed'].includes(input?.status) ? input.status : 'done'
  const findings = Array.isArray(input?.findings)
    ? input.findings.filter((item: any) => text(item?.title)).map((item: any) => ({
        title: text(item.title)!,
        ...Object.fromEntries((['detail', 'where', 'evidence', 'fix'] as const).flatMap((key) => (text(item[key]) ? [[key, text(item[key])]] : []))),
      }))
    : []
  const changes = Array.isArray(input?.changes) ? input.changes.map(text).filter(Boolean) as string[] : []
  return {
    status,
    summary: text(input?.summary) ?? '',
    ...(findings.length ? { findings } : {}),
    ...(changes.length ? { changes } : {}),
    ...(text(input?.next) ? { next: text(input.next) } : {}),
  }
}

function stripMeta(message: FairyMessage): LlmMessage {
  const { display, skills, quote, refs, at, ...rest } = message
  return rest as LlmMessage
}

function truncate(text: string) {
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${text.slice(0, MAX_RESULT_CHARS)}… [truncated ${text.length - MAX_RESULT_CHARS} characters; ask for less, e.g. with a filter or limit]`
}

export default Fairy
