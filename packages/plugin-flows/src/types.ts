import type { ChannelInfo, Logger, LocalizedText, Segment, z } from '@mushin/core'
import type { SourcedContent } from '@mushin/plugin-bots'

type SourcedContentLike = SourcedContent

/** Value types of node inputs and outputs; an input's value is converted to its type. */
export type PortType = 'text' | 'number' | 'boolean' | 'message' | 'any'

export interface PortDef {
  name: string
  type: PortType
  title?: LocalizedText
}

export type NodeCategory = 'trigger' | 'logic' | 'data' | 'ai' | 'action'

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
}

/** Starts a run when an incoming message matches. Has no exec input and one exec output, `next`. */
export interface TriggerNodeType<C = any> extends NodeTypeBase<C> {
  kind: 'trigger'
  /** Returns the trigger's outputs when the message matches, or nothing. */
  match(context: TriggerContext<C>): Record<string, unknown> | undefined
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
  user: { id: string; name?: string }
  channel: ChannelInfo
  isDirect: boolean
  mentioned: boolean
  messageId?: string
  send(content: string | SourcedContentLike): Promise<unknown>
  reply(content: string | SourcedContentLike): Promise<unknown>
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
}

/** An edge means "run next": from an exec output `exec:<name>` to a node's exec input `exec`. */
export interface FlowEdge {
  id: string
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
}

export interface FlowDocument {
  id: string
  name: string
  description?: string
  /** Bots that run this flow. */
  bots: string[]
  nodes: FlowNode[]
  edges: FlowEdge[]
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
  /** Set when the run was asked to stop after this node. */
  stopAt?: string
  error?: string
}
