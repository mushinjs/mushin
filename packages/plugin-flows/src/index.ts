import { type ChannelInfo, Context, MushinError, randomId, seg, Service, toJsonSchema, type UserInfo, z } from '@mushin/core'
import { type BotEvent, type CommandEntry, commandMatches, splitCommand } from '@mushin/plugin-bots'
import type {} from '@mushin/plugin-providers'
import type {} from '@mushin/plugin-storage'
import { FlowError, runFlow, type RunEnvironment } from './engine'
import { compile, type CompiledFlow, layout } from './graph'
import { builtinNodes, commandName, scheduleTarget } from './nodes'
import { migrateDataEdges } from './refs'
import type { FlowBot, FlowDocument, FlowEdge, FlowEvent, FlowGroup, FlowIssue, FlowNode, FlowSession, LlmLike, NodeType, RunStep, RunTrace, Variables, VariableScope, WaitOptions } from './types'

export * from './engine'
export * from './graph'
export * from './nodes'
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
  }))
  const flowEdges: FlowEdge[] = edges.map((edge) => ({
    id: edge.id ?? `e-${randomId(5)}`,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    targetHandle: edge.targetHandle,
  }))
  const migrated = migrateDataEdges(flowNodes, flowEdges, types)
  layout(migrated)
  return { nodes: migrated.nodes, edges: migrated.edges }
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
    // Flows saved before references replaced data connections, or with renamed node types.
    for (const doc of this.docs.values()) {
      const migrated = migrateDataEdges(doc.nodes, doc.edges, this.types)
      const renamed = migrated.nodes.some((node) => RENAMED_TYPES[node.type])
      if (!migrated.changed && !renamed) continue
      const nodes = migrated.nodes.map((node) => (RENAMED_TYPES[node.type] ? { ...node, type: RENAMED_TYPES[node.type] } : node))
      const next = { ...doc, nodes, edges: migrated.edges }
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
    return { ...doc, issues: this.issuesOf(doc) }
  }

  /** Validation issues, plus commands that another flow or plugin on the same bot also registers. */
  private issuesOf(doc: FlowDocument): FlowIssue[] {
    return [...this.compiledOf(doc).issues, ...this.commandIssues(doc)]
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
      createdAt: now,
      updatedAt: now,
    }
    await this.attach(doc.bots)
    await this.save(doc)
    this.logger.info('created flow %s', this.label(doc))
    return this.describe(doc)
  }

  async update(id: string, patch: Partial<{ name: string; description: string; adapter: string; bots: string[]; enabled: boolean; nodes: NodeInput[]; edges: EdgeInput[]; groups: GroupInput[] }>) {
    const doc = { ...this.get(id) }
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
    let consumed = false
    for (const compiled of this.flowsOf(botId)) {
      const result = await runFlow(compiled, this.environment(ctx, compiled.doc.id, session))
      if (result.matched) this.record(result.trace)
      if (result.consumed) consumed = true
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
    for (const compiled of this.flowsOf(botId)) {
      const result = await runFlow(compiled, { ...this.environment(ctx, compiled.doc.id, session), event: flowEvent })
      if (result.matched) this.record(result.trace)
    }
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
      name: 'flows.runs',
      description: 'Recent runs of a flow, oldest first: the message, the nodes and edges it went through, replies and errors.',
      risk: 'read',
      input: idInput.extend({ limit: z.number().int().min(1).max(TRACE_LIMIT).optional() }),
      handler: ({ id, limit }) => this.runs(id, limit),
    })
  }
}

export default FlowService
