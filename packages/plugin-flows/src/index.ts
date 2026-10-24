import { Context, MushinError, randomId, seg, Service, toJsonSchema, z } from '@mushin/core'
import type {} from '@mushin/plugin-bots'
import type {} from '@mushin/plugin-providers'
import type {} from '@mushin/plugin-storage'
import { runFlow } from './engine'
import { compile, type CompiledFlow, layout } from './graph'
import { builtinNodes } from './nodes'
import { migrateDataEdges } from './refs'
import type { FlowDocument, FlowEdge, FlowNode, FlowSession, LlmLike, NodeType, RunTrace, Variables, VariableScope } from './types'

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
  }
}

/** The bot plugin that runs flows; attaching a flow to a bot enables it there. */
export const RUNNER_PACKAGE = '@mushin/bot-plugin-flows'
const TRACE_LIMIT = 20

const nodeInput = z.object({
  id: z.string().optional().describe('Unique within the flow; generated when omitted'),
  type: z.string().describe('Node type from flows.nodeTypes, e.g. "trigger.keyword"'),
  label: z.string().optional().describe('Name shown on the node and in message provenance'),
  position: z.object({ x: z.number(), y: z.number() }).optional().describe('Canvas position; laid out automatically when omitted'),
  config: z.record(z.string(), z.any()).optional().describe('Settings matching the node type\'s config schema; strings may contain references such as {{n1.rest}}'),
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

const flowFields = {
  name: z.string().min(1),
  description: z.string().optional(),
  bots: z.array(z.string()).optional().describe('Bot ids that run this flow'),
  nodes: z.array(nodeInput).optional(),
  edges: z.array(edgeInput).optional(),
}

type NodeInput = z.infer<typeof nodeInput>
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

  constructor(ctx: Context) {
    super(ctx, 'flows')
    this.home = ctx
  }

  async *[Service.init]() {
    for (const key of await this.home.storage.list('flows')) {
      const doc = await this.home.storage.get<FlowDocument>(key)
      if (doc?.id) this.docs.set(doc.id, doc)
    }
    for (const type of builtinNodes) yield this.defineNode(type)
    // Flows saved before references replaced data connections.
    for (const doc of this.docs.values()) {
      const migrated = migrateDataEdges(doc.nodes, doc.edges, this.types)
      if (!migrated.changed) continue
      const next = { ...doc, nodes: migrated.nodes, edges: migrated.edges }
      this.docs.set(doc.id, next)
      await this.home.storage.set(`flows/${doc.id}`, next)
    }
    yield* this.defineActions()
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
    return { ...doc, issues: this.compiledOf(doc).issues }
  }

  list() {
    return [...this.docs.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((doc) => {
        const { issues } = this.compiledOf(doc)
        return {
          id: doc.id,
          name: doc.name,
          description: doc.description,
          bots: doc.bots,
          nodes: doc.nodes.length,
          errors: issues.filter((issue) => issue.severity === 'error').length,
          warnings: issues.filter((issue) => issue.severity === 'warning').length,
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

  async create(input: { name: string; description?: string; bots?: string[]; nodes?: NodeInput[]; edges?: EdgeInput[] }) {
    const { nodes, edges } = normalize(input.nodes ?? [], input.edges ?? [], this.types)
    const now = Date.now()
    const doc: FlowDocument = {
      id: randomId(),
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      bots: input.bots ?? [],
      nodes,
      edges,
      createdAt: now,
      updatedAt: now,
    }
    await this.attach(doc.bots)
    await this.save(doc)
    return this.describe(doc)
  }

  async update(id: string, patch: Partial<{ name: string; description: string; bots: string[]; nodes: NodeInput[]; edges: EdgeInput[] }>) {
    const doc = { ...this.get(id) }
    if (patch.name !== undefined) doc.name = patch.name
    if (patch.description !== undefined) doc.description = patch.description
    if (patch.nodes !== undefined || patch.edges !== undefined) {
      const normalized = normalize(patch.nodes ?? doc.nodes, patch.edges ?? doc.edges, this.types)
      doc.nodes = normalized.nodes
      doc.edges = normalized.edges
    }
    if (patch.bots !== undefined) {
      await this.attach(patch.bots.filter((bot) => !doc.bots.includes(bot)))
      doc.bots = patch.bots
    }
    await this.save(doc)
    return this.describe(doc)
  }

  async remove(id: string) {
    this.get(id)
    this.docs.delete(id)
    this.compiled.delete(id)
    this.traces.delete(id)
    await this.home.storage.delete(`flows/${id}`)
    this.home.emit('flows/changed')
    return { deleted: id }
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

  /** Runs every flow attached to the calling bot. Called by the flows bot plugin from the bot's context. */
  async dispatch(ctx: Context, session: FlowSession) {
    const botId = ctx.bot.id
    let consumed = false
    const flows = [...this.docs.values()]
      .filter((doc) => doc.bots.includes(botId))
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const doc of flows) {
      const compiled = this.compiledOf(doc)
      if (!compiled.runnable) continue
      const result = await runFlow(compiled, {
        session,
        vars: this.varsFor(doc.id, botId, session),
        llm: ctx.get('llm') as LlmLike | undefined,
        provider: ctx.bot.record.provider,
        logger: ctx.logger('flows'),
        botId,
      })
      if (result.matched) this.record(result.trace)
      if (result.consumed) consumed = true
    }
    return { consumed }
  }

  /** Sends a made-up message through a flow without a bot; replies are collected, not sent. */
  async test(id: string, input: { text: string; userName?: string; private?: boolean; mentioned?: boolean; nodeId?: string }) {
    const doc = this.get(id)
    if (input.nodeId && !doc.nodes.some((node) => node.id === input.nodeId)) {
      throw new MushinError('not_found', `No node with id "${input.nodeId}" in this flow`)
    }
    const compiled = this.compiledOf(doc)
    const user = { id: '10000', name: input.userName || 'Tester' }
    const session: FlowSession = {
      text: input.text,
      segments: [seg.text(input.text)],
      user,
      channel: input.private ? { type: 'private', id: user.id } : { type: 'group', id: 'test' },
      isDirect: !!input.private,
      mentioned: !!input.mentioned,
      send: async () => undefined,
      reply: async () => undefined,
    }
    const result = await runFlow(compiled, {
      session,
      vars: this.varsFor(doc.id, 'test', session),
      llm: this.home.get('llm') as LlmLike | undefined,
      logger: this.home.logger('flows'),
      test: true,
      stopAt: input.nodeId,
    })
    this.record(result.trace)
    return { matched: result.matched, consumed: result.consumed, trace: result.trace, issues: compiled.issues }
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
      description: 'Send a made-up message through a flow and return the path it took, each step\'s inputs and outputs, and the replies it would send. Nothing is sent to any chat, but LLM nodes do call the LLM.',
      risk: 'write',
      input: idInput.extend({
        text: z.string().min(1),
        userName: z.string().optional(),
        private: z.boolean().optional().describe('Pretend the message is a private chat'),
        mentioned: z.boolean().optional().describe('Pretend the message @-mentions the bot'),
        nodeId: z.string().optional().describe('Stop after this node: runs the path up to it and nothing after, to check one step'),
      }),
      handler: ({ id, ...input }) => this.test(id, input),
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
