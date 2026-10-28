import type { ChannelInfo, Logger, LocalizedText, Segment, UserInfo, z } from '@mushin/core'
import type { BotRole, GroupRole, ParsedCommand, SourcedContent } from '@mushin/plugin-bots'
import type { TriggerReply } from './engine'

type SourcedContentLike = SourcedContent

/** Value types of node inputs and outputs; an input's value is converted to its type. */
export type PortType = 'text' | 'number' | 'boolean' | 'message' | 'any'

export interface PortDef {
  name: string
  type: PortType
  title?: LocalizedText
}

/** `event`, `manage` and `platform` hold nodes for one chat platform, such as OneBot. */
export type NodeCategory = 'trigger' | 'event' | 'logic' | 'data' | 'ai' | 'action' | 'manage' | 'platform'

/**
 * Outputs read from a config value: `signature` turns `<score:number> [note]` into outputs `score`
 * and `note`; `names` makes one output per name in a list, such as the columns a query returns.
 */
export interface OutputsFromConfig {
  key: string
  format: 'signature' | 'names'
}

/** Exec outputs taken from a config array, e.g. one branch per intent label plus `other`. */
export interface ExecOutFromConfig {
  key: string
  extra?: string[]
}

interface NodeTypeBase<C> {
  /** Dotted id, such as `trigger.keyword`. */
  type: string
  category: NodeCategory
  title: LocalizedText
  description?: LocalizedText
  config?: z.ZodType<C>
  /** Inputs; each node binds them to a variable reference such as `{{n1.text}}` or to fixed text. */
  inputs?: PortDef[]
  /** Outputs, which later nodes reference as `{{<node id>.<output>}}`. */
  outputs?: PortDef[]
  /** More outputs that depend on the node's config, after `outputs`. */
  outputsFrom?: OutputsFromConfig
  /** Adapter ids the node works with, e.g. `['onebot']`; omitted means every adapter. */
  platforms?: string[]
  /**
   * Config strings whose references are escaped as they are filled in, by config key: a shell
   * command quotes each value, so a chat message cannot add commands of its own. Gets each value
   * as text and the node's config as saved.
   */
  escapeConfig?: Record<string, (value: string, config: C) => string>
  /**
   * Only people in the flow editor may add these nodes or change their config and inputs; the
   * Agent cannot. For nodes that reach outside the chat, such as running commands.
   */
  restricted?: boolean
  /**
   * Why the node cannot run right now, such as a plugin it needs being off; nothing when it can.
   * The editor greys it out with this text, and flows using it get an error.
   */
  unavailable?(): LocalizedText | undefined
}

/**
 * What starts a trigger: an incoming message, an adapter event (a member joins, a poke, a friend
 * request) or the clock.
 */
export type TriggerSource = 'message' | 'event' | 'schedule'

/** Starts a run. Has no exec input and one exec output, `next`. */
export interface TriggerNodeType<C = any> extends NodeTypeBase<C> {
  kind: 'trigger'
  /** Defaults to `message`. */
  source?: TriggerSource
  /**
   * Returns the trigger's outputs when the message, event or tick matches, or nothing. A
   * `TriggerReply` means the message was meant for this trigger but cannot start it (e.g. a command
   * with the wrong arguments): the text is sent back and the flow does not run.
   */
  match(context: TriggerContext<C>): Record<string, unknown> | TriggerReply | undefined
  /**
   * Schedule triggers: whether to fire at `now`. `last` is when it last fired, `since` when the
   * scheduler started watching it (bot start or flow save), so an interval counts from there.
   */
  due?(config: C, times: { now: Date; last?: number; since: number }): boolean
}

/** A step in the execution path: one exec input, named exec outputs. */
export interface ActionNodeType<C = any> extends NodeTypeBase<C> {
  kind: 'action'
  /** Exec outputs; defaults to `['next']`. */
  execOut?: string[]
  execOutFrom?: ExecOutFromConfig
  /**
   * The node may work longer than a run's working time (`RUN_LIMIT`) allows: its time does not
   * count toward it, and the node keeps to its own timeout instead. For commands and other tools.
   */
  long?: boolean
  /**
   * A resource the node uses, such as `bettergi`, from its config (references filled in). One run
   * at a time holds a resource, from its first node that uses it until the run ends; other runs
   * that need it queue in order.
   */
  resource?(config: C): string | undefined
  run(context: NodeContext<C>): Promise<NodeResult | void> | NodeResult | void
}

export type NodeType<C = any> = TriggerNodeType<C> | ActionNodeType<C>

export interface NodeResult {
  /** Which exec output to follow; the first one when omitted. */
  exec?: string
  outputs?: Record<string, unknown>
}

/** The incoming message as nodes see it. Real sessions and test runs both provide this. */
export interface FlowSession {
  text: string
  segments: Segment[]
  user: UserInfo
  channel: ChannelInfo
  isDirect: boolean
  mentioned: boolean
  messageId?: string
  /** The command the message runs, split by the bot's prefixes; command triggers fall back to `/`. */
  command?: ParsedCommand
  /** The sender is an admin or master of the bot. */
  isAdmin?: boolean
  /** The sender's role on the bot (master, admin, user); nothing when the permissions plugin is off. */
  role?(): BotRole | undefined
  /** The sender's role in the group, when the adapter can tell; nothing in private chats. */
  groupRole?(): Promise<GroupRole | undefined>
  send(content: string | SourcedContentLike): Promise<SentLike | undefined | void>
  reply(content: string | SourcedContentLike): Promise<SentLike | undefined | void>
}

/** What sending returns: at least the platform message id, when there is one. */
export interface SentLike {
  messageId?: string
}

/** An adapter event as flows see it; see `BotEvent` in plugin-bots. */
export interface FlowEvent {
  name: string
  data: Record<string, any>
  message?: { id?: string; text: string; segments: Segment[] }
}

/** The bot running the flow, for nodes that call the platform directly. */
export interface FlowBot {
  id: string
  /** Adapter type, e.g. `onebot`. */
  platform: string
  selfId?: string
  /** A raw adapter API call, e.g. OneBot's `set_group_ban`. Resolves to the response data. */
  call(action: string, params?: Record<string, any>): Promise<any>
  /** Sends to any chat, not only the current one. */
  send(channel: ChannelInfo, content: string | SourcedContentLike): Promise<SentLike | undefined | void>
  /** Recent messages of a chat from the bot's message log, oldest first: what people said and what the bot sent. */
  history?(channel: ChannelInfo, limit: number): Promise<ChatLine[]>
}

/** One message of a chat, for LLM context. */
export interface ChatLine {
  direction: 'in' | 'out'
  user: UserInfo
  text: string
  messageId?: string
}

export interface WaitOptions {
  /** `sender`: only the person who started the run. `anyone`: anyone in the chat. */
  who: 'sender' | 'anyone'
  seconds: number
}

export type VariableScope = 'run' | 'chat' | 'user' | 'flow'

export interface Variables {
  get(scope: VariableScope, name: string): unknown
  set(scope: VariableScope, name: string, value: unknown): void
}

export interface TriggerContext<C> {
  config: C
  session: FlowSession
  vars: Variables
  /** Set for runs started by an adapter event. */
  event?: FlowEvent
  /** Set for runs started by the clock. */
  now?: Date
}

export interface LlmLike {
  chat(options: any): Promise<{ text: string; source: { provider: string; model: string; tokens?: number } }>
}

/** Today's count and tokens for one key, such as a daily quota node in one chat. */
export interface DailyCounter {
  /** Local date, `YYYY-MM-DD`; a new day starts from zero. */
  day: string
  count: number
  tokens: number
}

/** Daily counters that survive restarts, for the daily quota node. Test runs get a scratch copy. */
export interface UsageStore {
  get(key: string): DailyCounter
  add(key: string, delta: { count?: number; tokens?: number }): DailyCounter
}

export interface NodeContext<C> extends TriggerContext<C> {
  inputs: Record<string, any>
  flow: { id: string; name: string }
  node: { id: string; label: string }
  /** This run's id, as flows.history lists it. */
  runId: string
  llm?: LlmLike
  /** The bot's default provider id, if it has one. */
  provider?: string
  logger: Logger
  signal: AbortSignal
  /** Shared by the nodes of one run: the latest LLM reply, for message provenance. */
  run: RunState
  /** The bot running the flow. Test runs get a stand-in that records calls instead of making them. */
  bot?: FlowBot
  /** The adapter event that started the run, if one did. */
  event?: FlowEvent
  /** Waits for the next message in this chat; resolves to nothing on timeout. Waiting does not count toward the run's time limit. */
  waitForMessage(options: WaitOptions): Promise<FlowSession | undefined>
  /** The run's persona: the one a persona node chose, else the bot's rules for this chat; nothing without one. */
  persona(): Promise<PersonaLike | undefined>
  /** Daily counters that survive restarts (a scratch copy in test runs). */
  usage: UsageStore
  test: boolean
}

export interface RunState {
  /** The latest LLM reply's provider, model and persona, copied into the provenance of later replies. */
  llm?: { provider: string; model: string; persona?: string }
  /**
   * The persona for the rest of the run: set by a persona node, or looked up from the bot's rules
   * the first time a node asks. `null` means none.
   */
  persona?: PersonaLike | null
  /** Called with the tokens of each LLM reply later in the run, e.g. by a daily quota node that let the run through. */
  onTokens?: ((tokens: number) => void)[]
}

/** A persona as nodes use it, with its variables already filled in. Kept by the personas plugin. */
export interface PersonaLike {
  id: string
  name: string
  /** System prompt: character, voice, background and things to avoid. */
  prompt: string
  /** Example exchanges, sent before the conversation. */
  examples?: { user: string; assistant: string }[]
  provider?: string
  model?: string
  temperature?: number
  /** Rewrite fixed reply text in the persona's voice (one extra LLM call per reply). */
  rewrite?: boolean
}

/** Finds the persona a message gets on a bot. The personas plugin provides it with `flows.usePersonas()`. */
export interface PersonaResolver {
  forRun(botId: string | undefined, session: FlowSession): Promise<PersonaLike | undefined> | PersonaLike | undefined
}

export interface FlowNode {
  id: string
  type: string
  label?: string
  position: { x: number; y: number }
  config: Record<string, any>
  /** Input name → a variable reference like `{{n1.text}}`, or text that may contain references. */
  inputs?: Record<string, string>
  /**
   * Skipped when the flow runs: a skipped trigger never starts a run, and a skipped step passes
   * straight on to its first exec output with no outputs of its own.
   */
  skip?: boolean
  /** Triggers: higher runs first when one message (or event) starts several triggers on a bot. Default 0. */
  priority?: number
  /**
   * Triggers: what this trigger keeps from also handling the message (or event) after it runs.
   * `flow`: later triggers of this flow. `flows`: later triggers of every flow on the bot.
   * `global`: those, the built-in commands and the bot's plugins (such as LLM chat). Missing: none.
   */
  intercept?: Exclude<Intercept, 'none'>
}

export type Intercept = 'none' | 'flow' | 'flows' | 'global'

/** `user`: made in the dashboard or the API. `agent`: made by the Agent. `plugin`: made by the plugin `plugin` (its package). */
export interface FlowSource {
  kind: 'user' | 'agent' | 'plugin'
  plugin?: string
}

/** An edge means "run next": from an exec output `exec:<name>` to a node's exec input `exec`. */
export interface FlowEdge {
  id: string
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
}

/** Nodes the editor frames together so they can be moved and copied as one. Has no effect on runs. */
export interface FlowGroup {
  id: string
  label?: string
  /** Node ids; a node is in at most one group. */
  nodes: string[]
  /** Shown as one box in the editor. */
  collapsed?: boolean
}

export interface FlowDocument {
  id: string
  name: string
  description?: string
  /** Adapter the flow is built for, e.g. `onebot`; nodes for other adapters are flagged. */
  adapter?: string
  /** Bots that run this flow. */
  bots: string[]
  /** A disabled flow keeps its bots but answers nothing; missing means enabled. */
  enabled?: boolean
  nodes: FlowNode[]
  edges: FlowEdge[]
  groups?: FlowGroup[]
  /** Who made the flow. A plugin's flows belong to it: only the plugin removes them. Missing: unknown (older flows). */
  source?: FlowSource
  /** Storage format; flows saved before interception scopes (format 2) are migrated on load. */
  format?: number
  createdAt: number
  updatedAt: number
}

export interface FlowIssue {
  severity: 'error' | 'warning'
  message: string
  nodeId?: string
  edgeId?: string
  /** For a node type no loaded plugin provides: the installed package that adds it. */
  plugin?: string
}

export interface TraceStep {
  nodeId: string
  /** The exec output taken, for action and trigger nodes. */
  exec?: string
  ms: number
  /** Values the node read from its data inputs. */
  inputs?: Record<string, unknown>
  /** Values the node produced, for triggers the values it matched. */
  outputs?: Record<string, unknown>
  error?: string
  /** The node is set to be skipped, so the run passed through it without running it. */
  skipped?: boolean
}

export interface RunTrace {
  id: string
  flowId: string
  botId?: string
  test: boolean
  at: number
  text: string
  steps: TraceStep[]
  /** Edges that carried execution, in order. */
  edges: string[]
  replies: string[]
  /** Platform API calls nodes made, in order; in test runs they were recorded but not made. */
  calls?: { action: string; params: Record<string, any>; error?: string }[]
  /** What started the run, when it was not a message. */
  event?: string
  /** Set when the run was asked to stop after this node. */
  stopAt?: string
  error?: string
}

/** Live progress of a run, sent as each node starts and finishes. */
export interface RunStep {
  runId: string
  flowId: string
  test: boolean
  nodeId: string
  /** The edge that led to the node, for nodes after the trigger. */
  edgeId?: string
  status: 'running' | 'ok' | 'error' | 'skipped'
}
