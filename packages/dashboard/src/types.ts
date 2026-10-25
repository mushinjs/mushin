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
  commands?: CommandSettings
  /** How the bot connects: `ws` (forward), `ws-reverse` or `http`, and the addresses involved. */
  connection?: { mode: string; address?: string; inbound?: string }
  createdAt: number
  status: BotStatus
  error?: string
  selfId?: string
  selfName?: string
}

export interface CommandSettings {
  prefixes?: string[]
  help?: boolean
  helpTitle?: string
  admins?: string[]
}

export interface CommandSource {
  kind: 'flow' | 'plugin' | 'builtin'
  id: string
  name: string
  nodeId?: string
}

export interface CommandEntry {
  name: string
  aliases?: string[]
  description?: string
  usage?: string
  hidden?: boolean
  permission?: 'all' | 'admin'
  botId: string
  source: CommandSource
}

export interface CommandList {
  commands: CommandEntry[]
  conflicts: { botId: string; name: string; sources: CommandSource[] }[]
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
  /** Source category: plugin, bot, adapter, flow, provider, agent, system or other. */
  tag?: string
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
  /** More outputs read from config: `signature` makes one output per command argument. */
  outputsFrom?: { key: string; format: 'signature' }
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
  skip?: boolean
  /** Triggers: higher runs first among the triggers one message starts on a bot. */
  priority?: number
  /** Event and schedule triggers: false stops later triggers once this one runs. */
  passOn?: boolean
}

/** A trigger's place in its bot's order (see `flows.triggers`). */
export interface TriggerSlot {
  flowId: string
  flowName: string
  nodeId: string
  /** The node's number in its flow, as the editor shows it. */
  number: number
  name: string
  type: string
  source: 'message' | 'event' | 'schedule'
  priority: number
  passesOn: boolean
  blockedBy?: { flowId: string; flowName: string; nodeId: string; name: string; priority: number }
  /** True: never runs on this bot. False: may not, depending on the message. */
  certain?: boolean
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
  /** Shown as one box in the editor. */
  collapsed?: boolean
}

export interface FlowDoc {
  id: string
  name: string
  description?: string
  /** Adapter the flow is built for, e.g. `onebot`. */
  adapter?: string
  bots: string[]
  /** False when the flow is turned off; missing means on. */
  enabled?: boolean
  nodes: FlowNodeDoc[]
  edges: FlowEdgeDoc[]
  groups?: FlowGroupDoc[]
  createdAt: number
  updatedAt: number
  issues: FlowIssue[]
  /** Triggers that an earlier trigger on one of the flow's bots keeps from running. */
  blocked?: (TriggerSlot & { botId: string })[]
}

export interface FlowSummary {
  id: string
  name: string
  description?: string
  adapter?: string
  bots: string[]
  enabled: boolean
  nodes: number
  errors: number
  warnings: number
  /** `all`: on some bot none of the flow's triggers can run; `some`: a few cannot. */
  blocked?: 'all' | 'some'
  triggers: { id: string; type: string; source: 'message' | 'event' | 'schedule'; summary: string; skip: boolean }[]
  createdAt: number
  updatedAt: number
}

export interface TraceStep {
  nodeId: string
  exec?: string
  ms: number
  inputs?: Record<string, unknown>
  outputs?: Record<string, unknown>
  error?: string
  /** The node is set to be skipped; the run passed through it. */
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
  status: 'running' | 'ok' | 'error' | 'skipped'
}

export interface PerfSample {
  t: number
  /** Percent of one CPU core. */
  cpu: number
  rss: number
  heapUsed: number
  heapTotal: number
  /** Event loop delay in ms. */
  loopMean: number
  loopMax: number
}

export interface StatsOverview {
  bots: { online: number; total: number }
  appPlugins: { enabled: number; total: number }
  botPlugins: { enabled: number }
  flows: { total: number; enabled: number; withErrors: number }
  commands: number
  providers: { total: number; passed: number }
  today: { received: number; sent: number; commands: number; flowRuns: number; flowErrors: number; llmCalls: number; llmTokens: number }
  versions: { mushin?: string; node: string; cordis?: string; plugins: { package: string; enabled: boolean; version?: string }[] }
  platform: string
  startedAt: number
  uptime: number
  dataBytes: number
  sample?: PerfSample
}

export interface StatsSeries {
  granularity: 'hour' | 'day'
  series: { key: string; name: string }[]
  points: { t: number; values: Record<string, number> }[]
}

export interface StatsTopRow {
  key: string
  name: string
  count: number
  bot?: string
  id?: string
  errors?: number
  tokens?: number
}
