import type { ChannelInfo, Logger, LocalizedText, Segment, UserInfo, z } from '@mushin/core'
import type { SourcedContent } from '@mushin/plugin-bots'

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
  /** Adapter ids the node works with, e.g. `['onebot']`; omitted means every adapter. */
  platforms?: string[]
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
  /** Returns the trigger's outputs when the message, event or tick matches, or nothing. */
  match(context: TriggerContext<C>): Record<string, unknown> | undefined
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
  chat(options: any): Promise<{ text: string; source: { provider: string; model: string } }>
}

export interface NodeContext<C> extends TriggerContext<C> {
  inputs: Record<string, any>
  flow: { id: string; name: string }
  node: { id: string; label: string }
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
  test: boolean
}

export interface RunState {
  llm?: { provider: string; model: string }
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
  nodes: FlowNode[]
  edges: FlowEdge[]
  groups?: FlowGroup[]
  createdAt: number
  updatedAt: number
}

export interface FlowIssue {
  severity: 'error' | 'warning'
  message: string
  nodeId?: string
  edgeId?: string
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
