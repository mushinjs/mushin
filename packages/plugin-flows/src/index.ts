import { type ChannelInfo, Context, MushinError, randomId, seg, Service, toJsonSchema, type UserInfo, z } from '@mushin/core'
import { type BotEvent, BUILTIN_PRIORITY, type CommandEntry, commandMatches, helpText, splitCommand } from '@mushin/plugin-bots'
import type {} from '@mushin/plugin-providers'
import type {} from '@mushin/plugin-storage'
import { FlowError, matchTriggers, runFlow, type RunEnvironment, type TriggerMatch } from './engine'
import { compile, type CompiledFlow, FLOW_FORMAT, interceptOf, layout, migrateIntercept, triggerPriority } from './graph'
import { builtinNodes, commandName, scheduleTarget } from './nodes'
import { overlap, triggerOrder, triggerSummary, type TriggerSlot } from './order'
import { migrateDataEdges } from './refs'
import type { FlowBot, FlowDocument, FlowEdge, FlowEvent, FlowGroup, FlowIssue, FlowNode, Intercept, FlowSession, LlmLike, NodeType, RunStep, RunTrace, Variables, VariableScope, WaitOptions } from './types'

export * from './engine'
export * from './graph'
export * from './nodes'
export * from './order'
export * from './refs'
export * from './types'

declare module '@mushin/core' {
  interface Context {
    flows: FlowService
  }

  interface Events {
    'flows/changed'(): void
    'flows/run'(trace: RunTrace): void
    'flows/step'(step: RunStep): void
  }
}

/** The bot plugin that runs flows; attaching a flow to a bot enables it there. */
export const RUNNER_PACKAGE = '@mushin/bot-plugin-flows'
const TRACE_LIMIT = 20
/** How often schedule triggers are checked. */
const TICK = 15_000
/** Node types that were renamed; flows saved with the old name are updated on load. */
const RENAMED_TYPES: Record<string, string> = { 'demo.waitReply': 'logic.waitReply' }

interface Waiter {
  botId: string
  channel: string
  /** Only this user's message ends the wait; any user's when unset. */
  userId?: string
  resolve(session: FlowSession | undefined): void
}

const channelKey = (channel: ChannelInfo) => `${channel.type}:${channel.id}`

const nodeInput = z.object({
  id: z.string().optional().describe('Unique within the flow; generated when omitted'),
  type: z.string().describe('Node type from flows.nodeTypes, e.g. "trigger.keyword"'),
  label: z.string().optional().describe('Name shown on the node and in message provenance'),
  position: z.object({ x: z.number(), y: z.number() }).optional().describe('Canvas position; laid out automatically when omitted'),
  config: z.record(z.string(), z.any()).optional().describe('Settings matching the node type\'s config schema; strings may contain references such as {{n1.rest}}'),
  skip: z.boolean().optional().describe('Keep the node but skip it when the flow runs: a skipped trigger never fires, a skipped step passes on to its first exec output'),
  priority: z.number().optional().describe('Triggers only: when one message starts several triggers on a bot (across all its flows), higher priority runs first; default 0'),
  intercept: z.enum(['none', 'flow', 'flows', 'global']).optional().describe('Triggers only: once this trigger runs, what may no longer handle the same message or event. none (default): nothing is stopped. flow: later triggers of this flow. flows: later triggers of every flow on the bot. global: those, the built-in /help and the bot plugins such as LLM chat'),
  inputs: z.record(z.string(), z.string()).optional()
    .describe('Input name → value: a reference like "{{n1.rest}}" ({{<node id>.<output>}}, {{sys.text|user|userId|groupId|isPrivate|mentioned}}, {{chat|user|flow|run.<variable>}}) or text containing references'),
})

const edgeInput = z.object({
  id: z.string().optional(),
  source: z.string().describe('Source node id'),
  sourceHandle: z.string().describe('"exec:<output>", e.g. "exec:next", "exec:true"'),
  target: z.string().describe('Target node id'),
  targetHandle: z.string().describe('Always "exec"'),
})

const groupInput = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  nodes: z.array(z.string()).describe('Ids of the nodes in the group'),
  collapsed: z.boolean().optional().describe('Show the group as one box in the editor'),
})

const flowFields = {
  name: z.string().min(1),
  description: z.string().optional(),
  adapter: z.string().optional().describe('Adapter type id from bots.adapters the flow is built for, e.g. "onebot"; node types list the adapters they need in platforms'),
  bots: z.array(z.string()).optional().describe('Bot ids that run this flow'),
  enabled: z.boolean().optional().describe('False keeps the flow and its bots but stops it from answering messages, events and schedules'),
  nodes: z.array(nodeInput).optional(),
  edges: z.array(edgeInput).optional(),
  groups: z.array(groupInput).optional().describe('Nodes framed together in the editor so they move and copy as one; no effect on runs'),
}

type NodeInput = z.infer<typeof nodeInput>
type GroupInput = z.infer<typeof groupInput>

/** Keeps groups of nodes that exist, each node in one group only; groups need two nodes. */
function normalizeGroups(groups: GroupInput[], nodes: FlowNode[]): FlowGroup[] {
  const known = new Set(nodes.map((node) => node.id))
  const taken = new Set<string>()
  const result: FlowGroup[] = []
  for (const group of groups) {
    const members = [...new Set(group.nodes)].filter((id) => known.has(id) && !taken.has(id))
    if (members.length < 2) continue
    for (const id of members) taken.add(id)
    result.push({ id: group.id ?? `g-${randomId(5)}`, ...(group.label ? { label: group.label } : {}), nodes: members, ...(group.collapsed ? { collapsed: true } : {}) })
  }
  return result
}

/** Unsaved edits of a flow, for previews. */
export interface FlowDraft {
  nodes: (Omit<FlowNode, 'position' | 'config' | 'intercept'> & { position?: FlowNode['position']; config?: FlowNode['config']; intercept?: Intercept })[]
  edges: (Omit<FlowEdge, 'id'> & { id?: string })[]
  bots?: string[]
}

/** A message to trace through a bot without sending it. */
export interface RouteInput {
  text: string
  /** Group roles come from the platform; `botAdmin` is in the bot's admin list; `private` is a private chat. */
  role?: 'member' | 'admin' | 'owner' | 'botAdmin' | 'private'
  mentioned?: boolean
  /** Call the model for LLM nodes instead of answering with a placeholder. */
  useLlm?: boolean
}

export interface TestInput {
  text?: string
  userName?: string
  private?: boolean
  mentioned?: boolean
  /** Pretend the sender is one of the bot's admins. */
  admin?: boolean
  nodeId?: string
  /** Pretend an adapter event happened, e.g. `{ name: 'group_increase', data: { group_id: 1, user_id: 2 } }`. */
  event?: { name: string; data?: Record<string, any> }
  /** Pretend this schedule trigger fired. */
  schedule?: string
  replies?: string[]
}
type EdgeInput = z.infer<typeof edgeInput>

/** Gives nodes and edges ids, turns old data connections into references and lays out nodes that have no position. */
function normalize(nodes: NodeInput[], edges: EdgeInput[], types: Map<string, NodeType>) {
  const used = new Set(nodes.map((node) => node.id).filter(Boolean))
  let counter = 0
  const nextId = () => {
    let id: string
    do id = `n${++counter}`
    while (used.has(id))
    used.add(id)
    return id
  }
  const flowNodes: FlowNode[] = nodes.map((node) => ({
    id: node.id ?? nextId(),
    type: node.type,
    ...(node.label ? { label: node.label } : {}),
    position: node.position ?? { x: Number.NaN, y: Number.NaN },
    config: node.config ?? {},
    ...(node.inputs && Object.keys(node.inputs).length ? { inputs: node.inputs } : {}),
    ...(node.skip ? { skip: true } : {}),
    ...(node.priority ? { priority: node.priority } : {}),
    ...(node.intercept && node.intercept !== 'none' ? { intercept: node.intercept } : {}),
  }))
  const flowEdges: FlowEdge[] = edges.map((edge) => ({
    id: edge.id ?? `e-${randomId(5)}`,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    targetHandle: edge.targetHandle,
  }))
  const migrated = migrateDataEdges(flowNodes, flowEdges, types)
  // Callers (often the Agent) may still send the old "let other plugins answer too" setting.
  const intercepts = migrateIntercept(migrated.nodes, false)
  const result = { nodes: intercepts.nodes, edges: migrated.edges }
  layout(result)
  return result
}

/**
 * Conversation flows: graphs of nodes that react to messages. Plugins add node types with
 * `ctx.flows.defineNode()`; the flows bot plugin runs a bot's flows on its incoming messages.
 */
export class FlowService extends Service {
  static inject = ['storage', 'actions']

  private home: Context
  private types = new Map<string, NodeType & { plugin: string }>()
  private docs = new Map<string, FlowDocument>()
  private compiled = new Map<string, CompiledFlow>()
  private traces = new Map<string, RunTrace[]>()
  private variables = new Map<string, Map<string, unknown>>()
  /** Bot contexts running the flows bot plugin, by bot id; event and schedule runs use them. */
  private runners = new Map<string, Context>()
  private waiters = new Set<Waiter>()
  /** `${flowId}|${nodeId}|${botId}` → when a schedule trigger last fired, and when it started being watched. */
  private fired = new Map<string, number>()
  private watched = new Map<string, number>()

  constructor(ctx: Context) {
    super(ctx, 'flows')
    this.home = ctx
  }

  /** Flow lifecycle lines for the global log, tagged `flow` in the dashboard. Runs log inside each bot. */
  private get logger() {
    return this.home.logger('flow')
  }

  async *[Service.init]() {
    for (const key of await this.home.storage.list('flows')) {
      const doc = await this.home.storage.get<FlowDocument>(key)
      if (doc?.id) this.docs.set(doc.id, doc)
    }
    for (const type of builtinNodes) yield this.defineNode(type)
    // Flows saved before references replaced data connections, with renamed node types, or before
    // triggers said what they intercept (their old default kept the message from everything after).
    for (const doc of this.docs.values()) {
      const migrated = migrateDataEdges(doc.nodes, doc.edges, this.types)
      const renamed = migrated.nodes.some((node) => RENAMED_TYPES[node.type])
      const intercepts = migrateIntercept(migrated.nodes, doc.format !== FLOW_FORMAT)
      if (!migrated.changed && !renamed && !intercepts.changed && doc.format === FLOW_FORMAT) continue
      const nodes = intercepts.nodes.map((node) => (RENAMED_TYPES[node.type] ? { ...node, type: RENAMED_TYPES[node.type] } : node))
      const next = { ...doc, nodes, edges: migrated.edges, format: FLOW_FORMAT }
      this.docs.set(doc.id, next)
      await this.home.storage.set(`flows/${doc.id}`, next)
      this.logger.info('migrated flow "%s" to the current format', doc.name)
    }
    this.logger.info('loaded %d flow(s)', this.docs.size)
    yield* this.defineActions()
    yield this.home.effect(() => {
      const timer = setInterval(() => this.tick(), TICK)
      return () => clearInterval(timer)
    }, 'flows schedule')
    yield this.home.effect(() => () => {
      for (const waiter of this.waiters) waiter.resolve(undefined)
      this.waiters.clear()
    }, 'flows waiters')
  }

  // ---- node types ----

  /** Registers a node type. It is removed when the calling plugin unloads. */
  defineNode<C>(type: NodeType<C>) {
    const ctx = this.ctx
    return ctx.effect(() => {
      if (this.types.has(type.type)) throw new Error(`node type "${type.type}" is already defined`)
      this.types.set(type.type, { ...(type as NodeType), plugin: ctx.fiber.name })
      this.recompile()
      return () => {
        this.types.delete(type.type)
        this.recompile()
      }
    }, `flows.defineNode(${type.type})`)
  }

  nodeTypes() {
    return [...this.types.values()].map((type) => ({
      type: type.type,
      kind: type.kind,
      category: type.category,
      title: type.title,
      description: type.description,
      plugin: type.plugin,
      configSchema: type.config ? toJsonSchema(type.config) : undefined,
      inputs: type.inputs ?? [],
      outputs: type.outputs ?? [],
      outputsFrom: type.outputsFrom,
      platforms: type.platforms,
      execIn: type.kind === 'action',
      execOut: type.kind === 'trigger' ? ['next'] : type.kind === 'action' ? type.execOut ?? ['next'] : [],
      execOutFrom: type.kind === 'action' ? type.execOutFrom : undefined,
    }))
  }

  private recompile() {
    this.compiled.clear()
    this.home.emit('flows/changed')
  }

  private compiledOf(doc: FlowDocument) {
    let compiled = this.compiled.get(doc.id)
    if (!compiled || compiled.doc !== doc) {
      compiled = compile(doc, this.types)
      this.compiled.set(doc.id, compiled)
    }
    return compiled
  }

  // ---- documents ----

  get(id: string) {
    const doc = this.docs.get(id)
    if (!doc) throw new MushinError('not_found', `No flow with id "${id}"`)
    return doc
  }

  describe(doc: FlowDocument) {
    return { ...doc, issues: this.issuesOf(doc), blocked: this.blockedIn(doc) }
  }

  /** Validation issues, commands another source also registers, and triggers that never run. */
  private issuesOf(doc: FlowDocument): FlowIssue[] {
    const blocked = this.blockedIn(doc).filter((slot) => slot.certain).map((slot): FlowIssue => ({
      severity: 'warning',
      nodeId: slot.nodeId,
      message: `"${slot.name}" never runs on ${this.botLabel(slot.botId)}: "${slot.blockedBy!.name}"${slot.blockedBy!.flowId === doc.id ? '' : ` of the flow "${slot.blockedBy!.flowName}"`} (priority ${slot.blockedBy!.priority}) answers first and does not pass the message on`,
    }))
    // A command that certainly never runs says so once, as blocked.
    const commands = this.commandIssues(doc).filter((issue) => !blocked.some((item) => item.nodeId === issue.nodeId))
    return [...this.compiledOf(doc).issues, ...commands, ...blocked]
  }

  private botLabel(botId: string) {
    try {
      return `the bot "${this.home.get('bots')?.get(botId).name ?? botId}"`
    } catch {
      return `the bot ${botId}`
    }
  }

  /** Each bot's triggers in the order a message reaches them; see `triggerOrder`. */
  triggersOn(botId: string): TriggerSlot[] {
    return triggerOrder(this.flowsOf(botId))
  }

  /** Triggers of a flow that an earlier trigger on one of its bots keeps from running, certainly or possibly. */
  private blockedIn(doc: FlowDocument) {
    if (doc.enabled === false) return []
    return doc.bots.flatMap((botId) => this.triggersOn(botId)
      .filter((slot) => slot.flowId === doc.id && slot.blockedBy)
      .map((slot) => ({ ...slot, botId })))
  }

  /**
   * The triggers on a bot that compete with one trigger: those an overlapping message also starts,
   * in the order they run, so the editor can reorder them.
   */
  competing(botId: string, flowId: string, nodeId: string, draft?: FlowDraft) {
    const flows = draft ? this.withDraft(botId, flowId, draft) : this.flowsOf(botId)
    const own = flows.find((flow) => flow.doc.id === flowId)?.nodes.get(nodeId)
    const slots = triggerOrder(flows)
    if (!own) return { triggers: slots.filter((slot) => slot.flowId === flowId && slot.nodeId === nodeId), plugins: this.pluginsAfter(botId) }
    const triggers = slots.filter((slot) => {
      if (slot.flowId === flowId && slot.nodeId === nodeId) return true
      const other = flows.find((flow) => flow.doc.id === slot.flowId)?.nodes.get(slot.nodeId)
      return !!other && (!!overlap(other, own) || !!overlap(own, other))
    })
    return { triggers, plugins: this.pluginsAfter(botId) }
  }

  /**
   * The bot's flows with one flow replaced by unsaved edits, so the editor can preview the order
   * before saving. The draft counts even with errors, and only if it still runs on the bot.
   */
  private withDraft(botId: string, flowId: string, draft: FlowDraft) {
    const saved = this.get(flowId)
    const doc: FlowDocument = {
      ...saved,
      nodes: migrateIntercept(draft.nodes.map(({ intercept, ...node }) => ({
        ...node,
        position: node.position ?? { x: 0, y: 0 },
        config: node.config ?? {},
        ...(intercept && intercept !== 'none' ? { intercept } : {}),
      })), false).nodes,
      edges: draft.edges.map((edge, index) => ({ ...edge, id: edge.id ?? `draft-${index}` })),
      bots: draft.bots ?? saved.bots,
    }
    const others = this.flowsOf(botId).filter((flow) => flow.doc.id !== flowId)
    if (!doc.bots.includes(botId) || doc.enabled === false) return others
    return [...others, compile(doc, this.types)].sort((a, b) => a.doc.createdAt - b.doc.createdAt)
  }

  /** Bot plugins that see messages after the flows, for the order list. */
  private pluginsAfter(botId: string) {
    try {
      return (this.home.get('bots')?.get(botId).plugins ?? [])
        .filter((entry) => entry.enabled && entry.package !== RUNNER_PACKAGE)
        .map((entry) => entry.package)
    } catch {
      return []
    }
  }

  /**
   * Puts triggers in this order on their bots by rewriting their priorities: the first one gets
   * the highest. Only the listed triggers change.
   */
  async setTriggerOrder(order: { flowId: string; nodeId: string }[]) {
    const found = order.map(({ flowId, nodeId }) => {
      const doc = this.get(flowId)
      const node = doc.nodes.find((item) => item.id === nodeId)
      if (!node) throw new MushinError('not_found', `No node "${nodeId}" in the flow "${doc.name}"`)
      return { doc, node }
    })
    const top = Math.max(order.length - 1, ...found.map(({ node }) => node.priority ?? 0))
    const changed = new Map<string, FlowDocument>()
    found.forEach(({ doc, node }, index) => {
      const priority = top - index
      if ((node.priority ?? 0) === priority) return
      const next = changed.get(doc.id) ?? { ...doc, nodes: doc.nodes.map((item) => ({ ...item })) }
      const target = next.nodes.find((item) => item.id === node.id)!
      if (priority) target.priority = priority
      else delete target.priority
      changed.set(doc.id, next)
    })
    for (const doc of changed.values()) await this.save(doc)
    if (changed.size) this.logger.info('reordered %d trigger(s) in %d flow(s)', order.length, changed.size)
    return order.map(({ flowId, nodeId }) => ({ flowId, nodeId, priority: this.get(flowId).nodes.find((node) => node.id === nodeId)?.priority ?? 0 }))
  }

  /** The commands a flow's command nodes register on a bot; skipped nodes register none. */
  private commandsOf(doc: FlowDocument, botId: string): CommandEntry[] {
    return doc.nodes.flatMap((node) => {
      if (node.type !== 'trigger.command' || node.skip) return []
      const config = this.compiledOf(doc).nodes.get(node.id)?.config ?? node.config
      const name = commandName(config.name)
      if (!name) return []
      return [{
        name,
        aliases: (Array.isArray(config.aliases) ? config.aliases : []).map(commandName).filter(Boolean),
        ...(config.description ? { description: String(config.description) } : {}),
        ...(config.usage ? { usage: String(config.usage) } : {}),
        ...(config.showInHelp === false ? { hidden: true } : {}),
        ...(config.permission === 'admin' ? { permission: 'admin' as const } : {}),
        ...(node.priority ? { priority: node.priority } : {}),
        botId,
        source: { kind: 'flow' as const, id: doc.id, name: doc.name, nodeId: node.id },
      }]
    })
  }

  /** Commands of the flows that run on a bot, for its `/help` and command list. */
  commandsOn(botId: string) {
    return this.flowsOf(botId).flatMap((compiled) => this.commandsOf(compiled.doc, botId))
  }

  private commandIssues(doc: FlowDocument): FlowIssue[] {
    if (doc.enabled === false) return []
    const bots = this.home.get('bots')
    const issues: FlowIssue[] = []
    const seen = new Set<string>()
    for (const botId of doc.bots) {
      const mine = this.commandsOf(doc, botId)
      if (!mine.length) continue
      // Other flows on the bot, even ones that cannot run yet, and commands from plugins and the bot itself.
      const others = [
        ...[...this.docs.values()].filter((other) => other.id !== doc.id && other.bots.includes(botId) && other.enabled !== false).flatMap((other) => this.commandsOf(other, botId)),
        ...(bots?.commands(botId).filter((entry) => entry.source.kind !== 'flow' && entry.source.kind !== 'builtin') ?? []),
      ]
      for (const entry of mine) {
        const names = [entry.name, ...(entry.aliases ?? [])]
        const clash = [...mine.filter((item) => item !== entry), ...others].find((other) => names.some((name) => commandMatches(other, name)))
        if (!clash) continue
        const key = `${entry.source.nodeId}|${clash.source.id}|${clash.source.nodeId ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        const where = clash.source.kind === 'flow' && clash.source.id === doc.id ? 'another node of this flow' : clash.source.kind === 'flow' ? `the flow "${clash.source.name}"` : `the plugin ${clash.source.name}`
        issues.push({ severity: 'warning', nodeId: entry.source.nodeId, message: `The command /${entry.name} is also registered by ${where} on the same bot; only one of them answers` })
      }
    }
    return issues
  }

  list() {
    return [...this.docs.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((doc) => {
        const issues = this.issuesOf(doc)
        const blocked = this.blockedIn(doc).filter((slot) => slot.certain)
        const triggers = this.compiledOf(doc).triggers.filter((id) => !doc.nodes.find((node) => node.id === id)?.skip)
        return {
          id: doc.id,
          name: doc.name,
          description: doc.description,
          adapter: doc.adapter,
          bots: doc.bots,
          enabled: doc.enabled !== false,
          nodes: doc.nodes.length,
          errors: issues.filter((issue) => issue.severity === 'error').length,
          warnings: issues.filter((issue) => issue.severity === 'warning').length,
          // `all`: on some bot, none of the flow's triggers can run; `some`: a few cannot.
          blocked: !blocked.length ? undefined : doc.bots.some((bot) => triggers.length && triggers.every((id) => blocked.some((slot) => slot.botId === bot && slot.nodeId === id))) ? 'all' : 'some',
          triggers: this.compiledOf(doc).triggers.flatMap((id) => {
            const entry = this.compiledOf(doc).nodes.get(id)!
            return entry.type?.kind === 'trigger' ? [{ id, type: entry.node.type, source: entry.type.source ?? 'message', summary: entry.node.label || triggerSummary(entry), skip: !!entry.node.skip }] : []
          }),
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        }
      })
  }

  private async save(doc: FlowDocument) {
    doc.updatedAt = Date.now()
    this.docs.set(doc.id, doc)
    this.compiled.delete(doc.id)
    await this.home.storage.set(`flows/${doc.id}`, doc)
    this.home.emit('flows/changed')
  }

  /** Checks the bot ids and turns on the flows bot plugin where it is not on yet. */
  private async attach(botIds: string[]) {
    const bots = this.home.get('bots')
    if (!botIds.length) return
    if (!bots) throw new MushinError('unavailable', 'The bots plugin is not running')
    for (const id of botIds) {
      const record = bots.get(id)
      const runner = record.plugins.find((entry) => entry.package === RUNNER_PACKAGE)
      if (!runner?.enabled) await bots.enablePlugin(id, RUNNER_PACKAGE)
    }
  }

  async create(input: { name: string; description?: string; adapter?: string; bots?: string[]; enabled?: boolean; nodes?: NodeInput[]; edges?: EdgeInput[]; groups?: GroupInput[] }) {
    const { nodes, edges } = normalize(input.nodes ?? [], input.edges ?? [], this.types)
    const groups = normalizeGroups(input.groups ?? [], nodes)
    const now = Date.now()
    const doc: FlowDocument = {
      id: randomId(),
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      ...(input.adapter ? { adapter: input.adapter } : {}),
      bots: input.bots ?? [],
      ...(input.enabled === false ? { enabled: false } : {}),
      nodes,
      edges,
      ...(groups.length ? { groups } : {}),
      format: FLOW_FORMAT,
      createdAt: now,
      updatedAt: now,
    }
    await this.attach(doc.bots)
    await this.save(doc)
    this.logger.info('created flow %s', this.label(doc))
    return this.describe(doc)
  }

  async update(id: string, patch: Partial<{ name: string; description: string; adapter: string; bots: string[]; enabled: boolean; nodes: NodeInput[]; edges: EdgeInput[]; groups: GroupInput[] }>) {
    const doc: FlowDocument = { ...this.get(id), format: FLOW_FORMAT }
    if (patch.name !== undefined) doc.name = patch.name
    if (patch.description !== undefined) doc.description = patch.description
    if (patch.adapter !== undefined) {
      if (patch.adapter) doc.adapter = patch.adapter
      else delete doc.adapter
    }
    if (patch.nodes !== undefined || patch.edges !== undefined) {
      const normalized = normalize(patch.nodes ?? doc.nodes, patch.edges ?? doc.edges, this.types)
      doc.nodes = normalized.nodes
      doc.edges = normalized.edges
    }
    if (patch.groups !== undefined || patch.nodes !== undefined) {
      const groups = normalizeGroups(patch.groups ?? doc.groups ?? [], doc.nodes)
      if (groups.length) doc.groups = groups
      else delete doc.groups
    }
    if (patch.enabled !== undefined) {
      if (patch.enabled) delete doc.enabled
      else doc.enabled = false
    }
    if (patch.bots !== undefined) {
      await this.attach(patch.bots.filter((bot) => !doc.bots.includes(bot)))
      doc.bots = patch.bots
    }
    await this.save(doc)
    if (patch.enabled !== undefined) this.logger.info('%s flow %s', patch.enabled ? 'enabled' : 'disabled', this.label(doc))
    else this.logger.info('saved flow %s', this.label(doc))
    return this.describe(doc)
  }

  async remove(id: string) {
    const doc = this.get(id)
    this.docs.delete(id)
    this.compiled.delete(id)
    this.traces.delete(id)
    await this.home.storage.delete(`flows/${id}`)
    this.home.emit('flows/changed')
    this.logger.info('deleted flow %s', this.label(doc))
    return { deleted: id }
  }

  private label(doc: FlowDocument) {
    return `"${doc.name}" (${doc.id})`
  }

  // ---- running ----

  private varsFor(flowId: string, botId: string, session: FlowSession): Pick<Variables, 'get' | 'set'> {
    const keyOf = (scope: VariableScope) => {
      switch (scope) {
        case 'chat': return `${flowId}|${botId}|chat|${session.channel.type}:${session.channel.id}`
        case 'user': return `${flowId}|${botId}|user|${session.user.id}`
        default: return `${flowId}|${botId}|flow`
      }
    }
    return {
      get: (scope, name) => this.variables.get(keyOf(scope))?.get(name),
      set: (scope, name, value) => {
        const key = keyOf(scope)
        let store = this.variables.get(key)
        if (!store) this.variables.set(key, store = new Map())
        store.set(name, value)
      },
    }
  }

  private record(trace: RunTrace) {
    const list = this.traces.get(trace.flowId) ?? []
    list.push(trace)
    if (list.length > TRACE_LIMIT) list.splice(0, list.length - TRACE_LIMIT)
    this.traces.set(trace.flowId, list)
    this.home.emit('flows/run', trace)
  }

  /** The bot behind a runner context, as nodes see it. */
  private flowBot(ctx: Context): FlowBot {
    const bot = ctx.bot
    return {
      id: bot.id,
      platform: bot.platform,
      selfId: bot.selfId,
      call: (action, params) => bot.call(action, params),
      send: (channel, content) => bot.send(channel, content),
    }
  }

  private environment(ctx: Context, docId: string, session: FlowSession): RunEnvironment {
    const botId = ctx.bot.id
    return {
      session,
      vars: this.varsFor(docId, botId, session),
      llm: ctx.get('llm') as LlmLike | undefined,
      provider: ctx.bot.record.provider,
      logger: ctx.logger('flows'),
      botId,
      bot: this.flowBot(ctx),
      waitForMessage: (options, origin) => this.waitFor(botId, origin, options),
      onStep: this.onStep,
    }
  }

  private onStep = (step: RunStep) => this.home.emit('flows/step', step)

  private flowsOf(botId: string) {
    return [...this.docs.values()]
      .filter((doc) => doc.bots.includes(botId) && doc.enabled !== false)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((doc) => this.compiledOf(doc))
      .filter((compiled) => compiled.runnable)
  }

  /** Called by the flows bot plugin: event and schedule runs on this bot go through `ctx`. */
  useRunner(ctx: Context) {
    const botId = ctx.bot.id
    return ctx.effect(() => {
      this.runners.set(botId, ctx)
      this.logger.info('runner started on bot %s; %d flow(s) attached', botId, this.flowsOf(botId).length)
      return () => {
        if (this.runners.get(botId) === ctx) this.runners.delete(botId)
        this.logger.info('runner stopped on bot %s', botId)
        for (const waiter of this.waiters) {
          if (waiter.botId !== botId) continue
          this.waiters.delete(waiter)
          waiter.resolve(undefined)
        }
      }
    }, 'flows.useRunner()')
  }

  /** Resolves with the next matching message in the chat, or nothing after `seconds`. */
  private waitFor(botId: string, origin: FlowSession, options: WaitOptions) {
    return new Promise<FlowSession | undefined>((resolve) => {
      const waiter: Waiter = {
        botId,
        channel: channelKey(origin.channel),
        userId: options.who === 'sender' ? origin.user.id : undefined,
        resolve: (session) => {
          clearTimeout(timer)
          this.waiters.delete(waiter)
          resolve(session)
        },
      }
      const timer = setTimeout(() => waiter.resolve(undefined), options.seconds * 1000)
      this.waiters.add(waiter)
    })
  }

  /** Hands a message to the oldest run waiting for it. Returns true when one took it. */
  private deliverToWaiter(botId: string, session: FlowSession) {
    for (const waiter of this.waiters) {
      if (waiter.botId !== botId || waiter.channel !== channelKey(session.channel)) continue
      if (waiter.userId !== undefined && waiter.userId !== session.user.id) continue
      waiter.resolve(session)
      return true
    }
    return false
  }

  /**
   * Runs every flow attached to the calling bot. Called by the flows bot plugin from the bot's context.
   * A message a waiting run is expecting goes to that run only.
   */
  async dispatch(ctx: Context, session: FlowSession) {
    const botId = ctx.bot.id
    if (this.deliverToWaiter(botId, session)) return { consumed: true }
    const runs = this.flowsOf(botId).map((compiled) => ({ compiled, env: this.environment(ctx, compiled.doc.id, session) }))
    return this.runOrdered(runs)
  }

  /**
   * Runs the triggers a message or event starts across a bot's flows, highest priority first (ties:
   * older flow first, then canvas order). A trigger that intercepts stops the later ones of its
   * flow (`flow`) or of every flow (`flows`, `global`); `global` also keeps the message from the
   * bot's built-in commands and plugins.
   */
  private async runOrdered(runs: { compiled: CompiledFlow; env: RunEnvironment }[]) {
    const matches: { compiled: CompiledFlow; env: RunEnvironment; match: TriggerMatch }[] = []
    for (const run of runs) {
      for (const match of matchTriggers(run.compiled, run.env)) matches.push({ ...run, match })
    }
    // Array sort is stable, so ties keep flow order and each flow's own order.
    matches.sort((a, b) => triggerPriority(b.compiled.nodes.get(b.match.nodeId)!) - triggerPriority(a.compiled.nodes.get(a.match.nodeId)!))
    let consumed = false
    const closed = new Set<string>()
    for (const { compiled, env, match } of matches) {
      if (closed.has(compiled.doc.id)) continue
      const result = await runFlow(compiled, { ...env, matched: match })
      this.record(result.trace)
      const intercept = interceptOf(compiled.nodes.get(match.nodeId)!)
      if (intercept === 'flow') closed.add(compiled.doc.id)
      if (intercept === 'flows' || intercept === 'global') {
        consumed = intercept === 'global'
        break
      }
    }
    return { consumed }
  }

  /** A session for a run that no message started; sending goes to `channel`. */
  private botSession(ctx: Context, channel: ChannelInfo | undefined, user: UserInfo | undefined, messageId?: string): FlowSession {
    const send = (content: Parameters<FlowSession['send']>[0]) => {
      if (!channel?.id) throw new FlowError('This run has no chat to send to')
      return ctx.bot.send(channel, content)
    }
    return {
      text: '',
      segments: [],
      user: user ?? { id: '' },
      channel: channel ?? { type: 'private', id: user?.id ?? '' },
      isDirect: channel?.type !== 'group',
      mentioned: false,
      ...(messageId ? { messageId } : {}),
      send,
      reply: send,
    }
  }

  /** Runs the event triggers of the calling bot's flows. Events without a normalized name are ignored. */
  async dispatchEvent(ctx: Context, event: BotEvent) {
    if (!event.name) return
    const botId = ctx.bot.id
    const flowEvent: FlowEvent = { name: event.name, data: event.data ?? {}, ...(event.message ? { message: event.message } : {}) }
    const channel = event.channel ?? (event.user?.id ? { type: 'private' as const, id: event.user.id } : undefined)
    const session = this.botSession(ctx, channel, event.user, event.message?.id)
    await this.runOrdered(this.flowsOf(botId).map((compiled) => ({ compiled, env: { ...this.environment(ctx, compiled.doc.id, session), event: flowEvent } })))
  }

  /** Fires schedule triggers that are due. Runs on a timer; tests call it with a fixed time. */
  async tick(now = new Date()) {
    const runs: Promise<unknown>[] = []
    for (const [botId, ctx] of this.runners) {
      if (ctx.bot.status !== 'online') continue
      for (const compiled of this.flowsOf(botId)) {
        for (const id of compiled.triggers) {
          const entry = compiled.nodes.get(id)!
          if (entry.type?.kind !== 'trigger' || entry.type.source !== 'schedule' || !entry.type.due) continue
          const key = `${compiled.doc.id}|${id}|${botId}`
          if (!this.watched.has(key)) this.watched.set(key, now.getTime())
          if (!entry.type.due(entry.config, { now, last: this.fired.get(key), since: this.watched.get(key)! })) continue
          this.fired.set(key, now.getTime())
          const target = scheduleTarget(entry.config)
          const session = this.botSession(ctx, target, undefined)
          runs.push(runFlow(compiled, { ...this.environment(ctx, compiled.doc.id, session), scheduled: { nodeId: id, now } })
            .then((result) => result.matched && this.record(result.trace)))
        }
      }
    }
    await Promise.all(runs)
  }

  /**
   * Sends a made-up message (or event, or schedule tick) through a flow without a bot; replies and
   * platform calls are collected, not made. `replies` answer the flow's waits for a reply, in order.
   */
  async test(id: string, input: TestInput) {
    const doc = this.get(id)
    if (input.nodeId && !doc.nodes.some((node) => node.id === input.nodeId)) {
      throw new MushinError('not_found', `No node with id "${input.nodeId}" in this flow`)
    }
    if (input.schedule && doc.nodes.find((node) => node.id === input.schedule)?.type !== 'trigger.schedule') {
      throw new MushinError('not_found', `No schedule trigger with id "${input.schedule}" in this flow`)
    }
    const compiled = this.compiledOf(doc)
    const text = input.text ?? ''
    const data = input.event?.data ?? {}
    const user: UserInfo = input.event
      ? { id: String(data.user_id ?? data.operator_id ?? '10000'), name: input.userName || undefined }
      : { id: '10000', name: input.userName || 'Tester' }
    const channel: ChannelInfo = input.event
      ? (data.group_id ? { type: 'group', id: String(data.group_id) } : { type: 'private', id: user.id })
      : input.private ? { type: 'private', id: user.id } : { type: 'group', id: 'test' }
    const prefixes = (() => {
      try {
        return this.home.get('bots')?.get(doc.bots[0])?.commands?.prefixes
      } catch {}
    })()
    const command = text ? splitCommand(text, prefixes?.length ? prefixes : undefined) : undefined
    const session: FlowSession = {
      text,
      segments: text ? [seg.text(text)] : [],
      user,
      channel,
      isDirect: channel.type === 'private',
      mentioned: !!input.mentioned,
      ...(command ? { command } : {}),
      isAdmin: !!input.admin,
      send: async () => undefined,
      reply: async () => undefined,
    }
    const replies = [...(input.replies ?? [])]
    const result = await runFlow(compiled, {
      session,
      vars: this.varsFor(doc.id, 'test', session),
      llm: this.home.get('llm') as LlmLike | undefined,
      logger: this.home.logger('flows'),
      test: true,
      stopAt: input.nodeId,
      onStep: this.onStep,
      ...(input.event ? { event: { name: input.event.name, data } } : {}),
      ...(input.schedule ? { scheduled: { nodeId: input.schedule, now: new Date() } } : {}),
      waitForMessage: async (_options, origin) => {
        const reply = replies.shift()
        if (reply === undefined) return undefined
        return { ...origin, text: reply, segments: [seg.text(reply)], send: origin.send, reply: origin.reply }
      },
    })
    this.record(result.trace)
    return { matched: result.matched, consumed: result.consumed, trace: result.trace, issues: this.issuesOf(doc) }
  }

  /**
   * Where a message would go on a bot, without sending anything: the triggers it starts across
   * the bot's flows (run in test mode, in order, until one keeps the message), then the built-in
   * commands and the bot plugins that would still see it. LLM nodes get a stand-in answer unless
   * `useLlm` is set.
   */
  async route(botId: string, input: RouteInput) {
    const bots = this.home.get('bots')
    if (!bots) throw new MushinError('unavailable', 'The bots plugin is not running')
    const record = bots.get(botId)
    const prefixes = record.commands?.prefixes?.filter(Boolean)
    const command = splitCommand(input.text, prefixes?.length ? prefixes : undefined)
    const isDirect = input.role === 'private'
    const groupRole = input.role === 'owner' || input.role === 'admin' || input.role === 'member' ? input.role : undefined
    const user: UserInfo = { id: '10000', name: 'Tester', ...(groupRole ? { role: groupRole } : {}) }
    const channel: ChannelInfo = isDirect ? { type: 'private', id: user.id } : { type: 'group', id: 'route-test' }
    const session: FlowSession = {
      text: input.text,
      segments: [seg.text(input.text)],
      user,
      channel,
      isDirect,
      mentioned: !!input.mentioned,
      ...(command ? { command } : {}),
      isAdmin: input.role === 'botAdmin',
      send: async () => undefined,
      reply: async () => undefined,
    }
    const llm: LlmLike | undefined = input.useLlm
      ? this.home.get('llm') as LlmLike | undefined
      : { chat: async () => ({ text: '[LLM skipped in this preview]', source: { provider: 'preview', model: 'none' } }) }

    // A preview starts from empty variables and leaves the real ones alone, so cooldowns and counters do not move.
    const scratch = new Map<string, unknown>()
    const varsOf = (flowId: string): Pick<Variables, 'get' | 'set'> => ({
      get: (scope, name) => scratch.get(`${flowId}|${scope}|${name}`),
      set: (scope, name, value) => void scratch.set(`${flowId}|${scope}|${name}`, value),
    })

    // Every trigger on the bot, in order, with whether this message starts it.
    const flows = this.flowsOf(botId)
    const slots = triggerOrder(flows)
    const matches = new Map<string, TriggerMatch & { compiled: CompiledFlow }>()
    for (const compiled of flows) {
      const env = { session, vars: varsOf(compiled.doc.id) }
      for (const match of matchTriggers(compiled, env)) matches.set(`${compiled.doc.id}|${match.nodeId}`, { ...match, compiled })
    }
    let consumed = false
    let stopped = false
    const closed = new Set<string>()
    const triggers = []
    for (const slot of slots.filter((item) => item.source === 'message')) {
      const match = matches.get(`${slot.flowId}|${slot.nodeId}`)
      if (!match) {
        triggers.push({ ...slot, state: 'no-match' as const })
        continue
      }
      if (stopped || closed.has(slot.flowId)) {
        triggers.push({ ...slot, state: 'blocked' as const })
        continue
      }
      const result = await runFlow(match.compiled, {
        session,
        vars: varsOf(match.compiled.doc.id),
        llm,
        logger: this.home.logger('flows'),
        test: true,
        matched: match,
        waitForMessage: async () => undefined,
      })
      const intercept = interceptOf(match.compiled.nodes.get(match.nodeId)!)
      const labels = Object.fromEntries(match.compiled.doc.nodes.flatMap((node) => (node.label ? [[node.id, node.label]] : [])))
      triggers.push({ ...slot, state: 'ran' as const, keeps: intercept !== 'none', trace: result.trace, labels })
      if (intercept === 'flow') closed.add(slot.flowId)
      if (intercept === 'flows' || intercept === 'global') stopped = true
      if (intercept === 'global') consumed = true
    }

    // After the flows: built-in commands and plugins, in the bot's middleware order.
    const after: { kind: 'builtin' | 'plugin'; name: string; state: 'answers' | 'receives' | 'not-reached' | 'ignores'; reply?: string }[] = []
    const builtin = command && bots.commands(botId).find((entry) => entry.source.kind === 'builtin' && commandMatches(entry, command.name))
    const order = [
      ...(bots.bot(botId)?.middlewareOrder() ?? []).filter((entry) => entry.plugin !== 'flows'),
      ...(builtin ? [{ plugin: `/${builtin.name}`, priority: BUILTIN_PRIORITY, builtin: true }] : []),
    ].sort((a, b) => b.priority - a.priority)
    for (const entry of order) {
      if ('builtin' in entry) {
        after.push({ kind: 'builtin', name: entry.plugin, state: consumed ? 'not-reached' : 'answers', ...(!consumed && builtin?.name === 'help' ? { reply: helpText(bots.commands(botId), record.commands) } : {}) })
        if (!consumed) consumed = true
        continue
      }
      after.push({ kind: 'plugin', name: entry.plugin, state: consumed ? 'not-reached' : 'receives' })
    }
    return {
      text: input.text,
      role: input.role ?? 'member',
      running: !!bots.bot(botId),
      triggers,
      after,
      replies: triggers.flatMap((item) => ('trace' in item && item.trace ? item.trace.replies.map((text) => ({ from: item.flowName, text })) : [])),
    }
  }

  runs(id: string, limit = TRACE_LIMIT) {
    this.get(id)
    return (this.traces.get(id) ?? []).slice(-limit)
  }

  // ---- actions ----

  private *defineActions() {
    const actions = this.home.actions
    const idInput = z.object({ id: z.string().describe('Flow id from flows.list') })

    yield actions.define({
      name: 'flows.nodeTypes',
      description: 'List node types for conversation flows: their ports, exec outputs and config schemas. Read this before creating or editing a flow.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.nodeTypes(),
    })

    yield actions.define({
      name: 'flows.list',
      description: 'List conversation flows with the bots they run on and their error and warning counts.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.list(),
    })

    yield actions.define({
      name: 'flows.get',
      description: 'Get one flow with its nodes, edges and validation issues.',
      risk: 'read',
      input: idInput,
      handler: ({ id }) => this.describe(this.get(id)),
    })

    yield actions.define({
      name: 'flows.create',
      description: 'Create a conversation flow. Every flow starts at a trigger node. Edges only say what runs next: from a node\'s "exec:<output>" handle (e.g. "exec:next", "exec:true", "exec:other") to the next node\'s "exec" handle. Values move by reference instead: set a node\'s inputs (or text in its config) to "{{<node id>.<output>}}" of a node that ran before it, or "{{sys.text}}" for the message. Take types, inputs, outputs and config from flows.nodeTypes. Set bots to run it on those bots, then check it with flows.test. Returns the flow with any validation issues.',
      risk: 'write',
      input: z.object(flowFields),
      handler: (input) => this.create(input),
    })

    yield actions.define({
      name: 'flows.update',
      description: 'Change a flow. Passing nodes or edges replaces the whole list, so send every node and edge that should remain. Returns the flow with validation issues.',
      risk: 'write',
      input: idInput.extend(z.object(flowFields).partial().shape),
      handler: ({ id, ...patch }) => this.update(id, patch),
    })

    yield actions.define({
      name: 'flows.delete',
      description: 'Delete a flow.',
      risk: 'dangerous',
      input: idInput,
      handler: ({ id }) => this.remove(id),
    })

    yield actions.define({
      name: 'flows.test',
      description: 'Send a made-up message through a flow and return the path it took, each step\'s inputs and outputs, the replies it would send and the platform API calls it would make. Nothing is sent to any chat and no platform API is called, but LLM nodes do call the LLM. Pass event instead of text to test event triggers, or schedule to fire a schedule trigger.',
      risk: 'write',
      input: idInput.extend({
        text: z.string().optional().describe('The message; required unless event or schedule is set'),
        event: z.object({
          name: z.string().describe('Normalized event name, as the event trigger nodes describe, e.g. "group_increase", "notify.poke", "request.friend"'),
          data: z.record(z.string(), z.any()).optional().describe('The event as the platform sends it, e.g. OneBot fields such as group_id and user_id'),
        }).optional(),
        schedule: z.string().optional().describe('Id of a schedule trigger node to fire'),
        replies: z.array(z.string()).optional().describe('Messages that answer the flow\'s "wait for reply" nodes, in order; a wait with none left times out'),
        userName: z.string().optional(),
        private: z.boolean().optional().describe('Pretend the message is a private chat'),
        mentioned: z.boolean().optional().describe('Pretend the message @-mentions the bot'),
        admin: z.boolean().optional().describe('Pretend the sender is a bot admin, for admin-only commands'),
        nodeId: z.string().optional().describe('Stop after this node: runs the path up to it and nothing after, to check one step'),
      }),
      handler: ({ id, ...input }) => {
        if (!input.event && !input.schedule && !input.text) throw new MushinError('invalid_input', 'Give text, event or schedule')
        return this.test(id, input)
      },
    })

    yield actions.define({
      name: 'flows.triggers',
      description: 'The triggers on one bot in the order a message reaches them (higher priority first), with the earlier trigger that keeps each one from running. With flow and node, only the triggers that compete with that trigger, plus the bot plugins that see messages after the flows.',
      risk: 'read',
      input: z.object({
        bot: z.string().describe('Bot id from bots.list'),
        flow: z.string().optional(),
        node: z.string().optional(),
        draft: z.object({
          nodes: z.array(nodeInput.extend({ id: z.string() })),
          edges: z.array(edgeInput),
          bots: z.array(z.string()).optional(),
        }).optional().describe('Unsaved nodes, edges and bots of the flow, to preview the order before saving'),
      }),
      handler: ({ bot, flow, node, draft }) => (flow && node ? this.competing(bot, flow, node, draft) : { triggers: this.triggersOn(bot), plugins: this.pluginsAfter(bot) }),
    })

    yield actions.define({
      name: 'flows.route',
      description: 'Show where a message would go on a bot without sending anything: which triggers it starts across the bot\'s flows (each run in test mode, in order, until one keeps the message), their steps and replies, then which built-in commands and bot plugins would still see it. LLM nodes answer with a placeholder unless useLlm is true.',
      risk: 'read',
      input: z.object({
        bot: z.string().describe('Bot id from bots.list'),
        text: z.string().min(1),
        role: z.enum(['member', 'admin', 'owner', 'botAdmin', 'private']).optional().describe('Who sends it: a group member, group admin or owner, someone in the bot\'s admin list, or a private chat'),
        mentioned: z.boolean().optional(),
        useLlm: z.boolean().optional(),
      }),
      handler: ({ bot, ...input }) => this.route(bot, input),
    })

    yield actions.define({
      name: 'flows.setTriggerOrder',
      description: 'Put triggers in this order, first runs first, by rewriting their priorities. Get them from flows.triggers.',
      risk: 'write',
      input: z.object({ order: z.array(z.object({ flowId: z.string(), nodeId: z.string() })).min(1) }),
      handler: ({ order }) => this.setTriggerOrder(order),
    })

    yield actions.define({
      name: 'flows.runs',
      description: 'Recent runs of a flow, oldest first: the message, the nodes and edges it went through, replies and errors.',
      risk: 'read',
      input: idInput.extend({ limit: z.number().int().min(1).max(TRACE_LIMIT).optional() }),
      handler: ({ id, limit }) => this.runs(id, limit),
    })
  }
}

export default FlowService
