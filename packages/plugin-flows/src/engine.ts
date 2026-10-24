import { type Logger, randomId, seg } from '@mushin/core'
import type { CompiledFlow } from './graph'
import { interpolate, interpolateConfig, SCOPES, sysValues, toText } from './refs'
import type { FlowSession, LlmLike, PortType, RunState, RunTrace, Variables, VariableScope } from './types'

export const MAX_STEPS = 200

export class FlowError extends Error {
  name = 'FlowError'
}

/** Converts a value to what an input port expects. */
export function coerce(value: unknown, type: PortType): unknown {
  switch (type) {
    case 'text':
      return toText(value)
    case 'number': {
      const number = Number(value)
      return Number.isFinite(number) ? number : 0
    }
    case 'boolean':
      if (typeof value === 'string') return value !== '' && value !== 'false' && value !== '0'
      return Boolean(value)
    case 'message':
      if (Array.isArray(value)) return value
      return [seg.text(coerce(value, 'text') as string)]
    default:
      return value
  }
}

export interface RunEnvironment {
  session: FlowSession
  /** Variables for the chat/user/flow scopes; run-scoped ones live only for this run. */
  vars: Pick<Variables, 'get' | 'set'>
  llm?: LlmLike
  provider?: string
  logger: Logger
  botId?: string
  test?: boolean
  signal?: AbortSignal
  /** Stop once this node has run: the path up to it runs, nothing after it. */
  stopAt?: string
}

export interface RunResult {
  /** A trigger matched, so the flow ran. */
  matched: boolean
  /** A matched trigger does not let other plugins see the message. */
  consumed: boolean
  trace: RunTrace
}

/** Runs one flow against one incoming message: every matching trigger starts a run. */
export async function runFlow(flow: CompiledFlow, env: RunEnvironment): Promise<RunResult> {
  const trace: RunTrace = {
    id: randomId(8),
    flowId: flow.doc.id,
    botId: env.botId,
    test: !!env.test,
    at: Date.now(),
    text: env.session.text,
    steps: [],
    edges: [],
    replies: [],
    ...(env.stopAt ? { stopAt: env.stopAt } : {}),
  }
  const runVars = new Map<string, unknown>()
  const vars: Variables = {
    get: (scope: VariableScope, name: string) => (scope === 'run' ? runVars.get(name) : env.vars.get(scope, name)),
    set: (scope: VariableScope, name: string, value: unknown) => {
      if (scope === 'run') runVars.set(name, value)
      else env.vars.set(scope, name, value)
    },
  }

  // Record replies for the trace without changing how they are sent.
  const session: FlowSession = Object.create(env.session)
  const remember = (content: unknown) => {
    const text = typeof content === 'string' ? content : (content as { text?: string })?.text ?? ''
    trace.replies.push(text)
  }
  session.send = (content) => {
    remember(content)
    return env.session.send(content)
  }
  session.reply = (content) => {
    remember(content)
    return env.session.reply(content)
  }

  const state: RunState = {}
  const outputs = new Map<string, Record<string, unknown>>()
  const sys = sysValues(session)
  const signal = env.signal ?? AbortSignal.timeout(60_000)
  let steps = 0
  let matched = false
  let consumed = false
  let stopped = false

  const lookup = (head: string, name: string): unknown => {
    if (outputs.has(head)) return outputs.get(head)![name]
    if (head === 'sys') return sys[name]
    if ((SCOPES as string[]).includes(head)) return vars.get(head as VariableScope, name)
    return undefined
  }

  /** Input bindings with references filled in, converted to each input's type. Unbound inputs stay undefined. */
  const resolveInputs = (id: string) => {
    const entry = flow.nodes.get(id)!
    const inputs: Record<string, unknown> = {}
    for (const port of entry.ports?.inputs ?? []) {
      const binding = entry.node.inputs?.[port.name]
      if (binding === undefined || binding.trim() === '') continue
      inputs[port.name] = coerce(interpolate(binding, lookup), port.type)
    }
    return inputs
  }

  const contextFor = (id: string, inputs: Record<string, unknown>) => {
    const entry = flow.nodes.get(id)!
    return {
      config: interpolateConfig(entry.config, lookup),
      inputs,
      session,
      vars,
      flow: { id: flow.doc.id, name: flow.doc.name },
      node: { id, label: entry.node.label || entry.node.type },
      llm: env.llm,
      provider: env.provider,
      logger: env.logger,
      signal,
      run: state,
    }
  }

  const follow = async (id: string, exec: string | undefined) => {
    if (!exec || stopped) return
    for (const link of flow.execOut.get(`${id}|${exec}`) ?? []) {
      trace.edges.push(link.edgeId)
      await visit(link.target)
    }
  }

  const visit = async (id: string): Promise<void> => {
    if (signal.aborted) throw new FlowError('The run took too long and was stopped')
    if (++steps > MAX_STEPS) throw new FlowError(`Stopped after ${MAX_STEPS} steps; check for a loop in the flow`)
    const entry = flow.nodes.get(id)
    if (entry?.type?.kind !== 'action' || !entry.ports) return
    const started = Date.now()
    const inputs = resolveInputs(id)
    let exec: string | undefined
    try {
      const result = await entry.type.run(contextFor(id, inputs))
      exec = result?.exec ?? entry.ports.execOut[0]
      outputs.set(id, result?.outputs ?? {})
      trace.steps.push({ nodeId: id, exec, ms: Date.now() - started, inputs, outputs: result?.outputs ?? {} })
    } catch (error) {
      trace.steps.push({ nodeId: id, ms: Date.now() - started, inputs, error: String((error as Error)?.message ?? error) })
      throw error
    }
    if (id === env.stopAt) stopped = true
    await follow(id, exec)
  }

  try {
    for (const id of flow.triggers) {
      if (stopped) break
      const entry = flow.nodes.get(id)!
      if (entry.type?.kind !== 'trigger') continue
      const started = Date.now()
      const result = entry.type.match({ config: entry.config, session, vars })
      if (!result) continue
      matched = true
      if (!entry.config.passThrough) consumed = true
      outputs.set(id, result)
      trace.steps.push({ nodeId: id, exec: 'next', ms: Date.now() - started, outputs: result })
      if (id === env.stopAt) stopped = true
      await follow(id, 'next')
    }
  } catch (error) {
    trace.error = String((error as Error)?.message ?? error)
    env.logger.warn('flow "%s" stopped: %s', flow.doc.name, trace.error)
  }
  return { matched, consumed, trace }
}
