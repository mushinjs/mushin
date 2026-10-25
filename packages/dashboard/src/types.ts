// Shapes returned by the Mushin.js API. They mirror the backend types; the dashboard does not
// import backend packages because those depend on Node.js.

export type LocalizedText = string | Record<string, string>
export type JsonSchema = Record<string, any>
export type Risk = 'read' | 'write' | 'dangerous'

export interface ActionInfo {
  name: string
  description: string
  risk: Risk
  client: boolean
  plugin: string
  inputSchema: JsonSchema
}

export interface PluginManifest {
  kind: 'app' | 'bot'
  displayName?: LocalizedText
  description?: LocalizedText
  essential?: boolean
  platforms?: string[]
  category?: string
}

export type PluginStatus = 'disabled' | 'pending' | 'loading' | 'active' | 'failed' | 'unloading'

export interface AppPlugin {
  id: string
  package: string
  enabled: boolean
  config: Record<string, any>
  configSchema?: JsonSchema
  manifest?: PluginManifest
  version?: string
  status: PluginStatus
  error?: string
}

export interface CatalogEntry {
  package: string
  version: string
  local: boolean
  manifest: PluginManifest
}

export interface ProviderPreset {
  id: string
  label: LocalizedText
  config: Record<string, unknown>
  models?: string[]
}

export interface ProviderType {
  id: string
  displayName: LocalizedText
  configSchema: JsonSchema
  secrets: string[]
  presets: ProviderPreset[]
}

export interface ProviderTest {
  ok: boolean
  at: number
  latencyMs?: number
  model?: string
  error?: string
}

export interface ProviderDraft {
  name: string
  type: string
  config: Record<string, any>
  models: string[]
  defaultModel?: string
}

export interface Provider {
  id: string
  name: string
  type: string
  config: Record<string, any>
  models: string[]
  defaultModel?: string
  isDefault?: boolean
  lastTest?: ProviderTest
  typeAvailable: boolean
  createdAt: number
}

export type BotStatus = 'offline' | 'connecting' | 'online' | 'error'

export interface BotPluginEntry {
  package: string
  enabled: boolean
  config: Record<string, any>
}

export interface Bot {
  id: string
  name: string
  enabled: boolean
  adapter: { type: string; config: Record<string, any> }
  plugins: BotPluginEntry[]
  provider?: string
  createdAt: number
  status: BotStatus
  error?: string
  selfId?: string
  selfName?: string
}

export interface BotStatusInfo {
  id: string
  status: BotStatus
  error?: string
  selfId?: string
  selfName?: string
}

export interface AdapterType {
  id: string
  displayName: LocalizedText
  configSchema: JsonSchema
  secrets: string[]
  segments: string[]
}

export interface BotPluginInfo {
  package: string
  version: string
  manifest: PluginManifest
  enabled: boolean
  config: Record<string, any>
  configSchema?: JsonSchema
  status: PluginStatus
  error?: string
}

export interface Segment {
  type: string
  data: Record<string, any>
}

export type Provenance =
  | { kind: 'user' }
  | { kind: 'plugin'; plugin: string }
  | { kind: 'llm'; plugin?: string; provider: string; model: string; latencyMs: number; tokens?: number }
  | { kind: 'flow'; flow: string; node: string; provider?: string; model?: string }
  | { kind: 'agent'; session: string }
  | { kind: 'manual' }

export interface ChannelInfo {
  type: 'group' | 'private'
  id: string
  name?: string
}

export interface MessageRecord {
  id: string
  botId: string
  messageId?: string
  direction: 'in' | 'out'
  channel: ChannelInfo
  user: { id: string; name?: string }
  segments: Segment[]
  timestamp: number
  replyTo?: string
  type: string
  platforms: string[]
  source: Provenance
}

export interface ChannelSummary extends ChannelInfo {
  lastAt: number
  lastText: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: any
  display?: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  isError?: boolean
  at: number
}

export interface AgentSessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  running: boolean
}

export type AgentEvent = { session: string } & (
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'tool-call'; id: string; action: string; input: unknown; risk: Risk }
  | { type: 'confirm'; id: string; action: string; input: unknown }
  | { type: 'tool-result'; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: string }
)

export interface LogLine {
  /** Set on lines from a bot's own log. */
  botId?: string
  sn: number
  ts: number
  type: string
  name: string
  text: string
}

export type PortType = 'text' | 'number' | 'boolean' | 'message' | 'any'
export type NodeCategory = 'trigger' | 'event' | 'logic' | 'data' | 'ai' | 'action' | 'manage' | 'platform'

export interface PortDef {
  name: string
  type: PortType
  title?: LocalizedText
}

export interface NodeTypeInfo {
  type: string
  kind: 'trigger' | 'action' | 'data'
  category: NodeCategory
  title: LocalizedText
  description?: LocalizedText
  plugin: string
  configSchema?: JsonSchema
  inputs: PortDef[]
  outputs: PortDef[]
  execIn: boolean
  execOut: string[]
  execOutFrom?: { key: string; extra?: string[] }
  /** Adapter ids the node works with; omitted means every adapter. */
  platforms?: string[]
}

export interface FlowNodeDoc {
  id: string
  type: string
  label?: string
  position: { x: number; y: number }
  config: Record<string, any>
  inputs?: Record<string, string>
}

export interface FlowEdgeDoc {
  id: string
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
}

export interface FlowIssue {
  severity: 'error' | 'warning'
  message: string
  nodeId?: string
  edgeId?: string
}

/** Nodes the editor frames together; no effect on runs. */
export interface FlowGroupDoc {
  id: string
  label?: string
  nodes: string[]
}

export interface FlowDoc {
  id: string
  name: string
  description?: string
  /** Adapter the flow is built for, e.g. `onebot`. */
  adapter?: string
  bots: string[]
  nodes: FlowNodeDoc[]
  edges: FlowEdgeDoc[]
  groups?: FlowGroupDoc[]
  createdAt: number
  updatedAt: number
  issues: FlowIssue[]
}

export interface FlowSummary {
  id: string
  name: string
  description?: string
  adapter?: string
  bots: string[]
  nodes: number
  errors: number
  warnings: number
  updatedAt: number
}

export interface TraceStep {
  nodeId: string
  exec?: string
  ms: number
  inputs?: Record<string, unknown>
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
  edges: string[]
  replies: string[]
  /** Platform API calls; in test runs recorded but not made. */
  calls?: { action: string; params: Record<string, any>; error?: string }[]
  /** What started the run when it was not a message: an event name, or `schedule`. */
  event?: string
  stopAt?: string
  error?: string
}

/** Live progress of a run, sent as each node starts and finishes. */
export interface RunStep {
  runId: string
  flowId: string
  test: boolean
  nodeId: string
  edgeId?: string
  status: 'running' | 'ok' | 'error'
}
