import { type Logger, randomId, seg } from '@mushin/core'
import type { CompiledFlow } from './graph'
import { interpolate, interpolateConfig, SCOPES, sysValues, toText } from './refs'
import type { FlowBot, FlowEvent, FlowSession, LlmLike, PortType, RunState, RunStep, RunTrace, TriggerSource, Variables, VariableScope, WaitOptions } from './types'

export const MAX_STEPS = 200
/** How long a run may work; time spent waiting for a reply does not count. */
export const RUN_LIMIT = 60_000
/** The longest a single wait for a reply may last. */
export const MAX_WAIT = 3_600_000

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
  /** Set for runs started by an adapter event: only event triggers are tried. */
  event?: FlowEvent
  /** Set for runs started by the clock: only this schedule trigger fires. */
  scheduled?: { nodeId: string; now: Date }
  bot?: FlowBot
  /** Working time allowed, in ms; `RUN_LIMIT` by default. */
  limit?: number
  /** Waits for the next message in the session's chat. Without it, waits time out at once. */
  waitForMessage?(options: WaitOptions, session: FlowSession): Promise<FlowSession | undefined>
  /** Called as each node starts and finishes, so the editor can show the run live. */
  onStep?(step: RunStep): void
}

/**
 * A run's time limit that can be paused: waiting for a reply can take minutes, but only the time
 * a run spends working counts toward `RUN_LIMIT`.
 */
function runBudget(limit: number) {
  const controller = new AbortController()
  let remaining = limit
  let startedAt = Date.now()
  let timer: NodeJS.Timeout | undefined
  const start = () => {
    startedAt = Date.now()
    timer = setTimeout(() => controller.abort(new FlowError('The run took too long and was stopped')), remaining)
  }
  start()
  return {
    signal: controller.signal,
    pause() {
      clearTimeout(timer)
      remaining = Math.max(0, remaining - (Date.now() - startedAt))
    },
    resume: start,
    dispose: () => clearTimeout(timer),
  }
}

function sourceOf(env: RunEnvironment): TriggerSource {
  return env.scheduled ? 'schedule' : env.event ? 'event' : 'message'
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
    text: env.event ? `[${env.event.name}]` : env.scheduled ? '[schedule]' : env.session.text,
    ...(env.event ? { event: env.event.name } : env.scheduled ? { event: 'schedule' } : {}),
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
  const remember = (content: unknown, to?: string) => {
    const text = typeof content === 'string' ? content : (content as { text?: string })?.text ?? ''
    trace.replies.push(to ? `→ ${to}: ${text}` : text)
  }
  session.send = (content) => {
    remember(content)
    return env.session.send(content)
  }
  session.reply = (content) => {
    remember(content)
    return env.session.reply(content)
  }

  // Platform calls are recorded for the trace; test runs record them without making them.
  let bot: FlowBot | undefined
  if (env.bot || env.test) {
    const real = env.bot
    const calls: NonNullable<RunTrace['calls']> = trace.calls = []
    bot = {
      id: real?.id ?? 'test',
      platform: real?.platform ?? 'test',
      selfId: real?.selfId,
      async call(action, params = {}) {
        const entry: (typeof calls)[number] = { action, params }
        calls.push(entry)
        if (env.test || !real) return null
        try {
          return await real.call(action, params)
        } catch (error) {
          entry.error = String((error as Error)?.message ?? error)
          throw error
        }
      },
      async send(channel, content) {
        remember(content, `${channel.type}:${channel.id}`)
        if (env.test || !real) return undefined
        return real.send(channel, content)
      },
    }
  }

  const state: RunState = {}
  const outputs = new Map<string, Record<string, unknown>>()
  const sys = sysValues(session)
  const budget = env.signal ? undefined : runBudget(env.limit ?? RUN_LIMIT)
  const signal = env.signal ?? budget!.signal
  const waitForMessage = async (options: WaitOptions) => {
    if (!env.waitForMessage) return undefined
    const seconds = Math.min(Math.max(options.seconds, 1), MAX_WAIT / 1000)
    budget?.pause()
    try {
      return await env.waitForMessage({ ...options, seconds }, env.session)
    } finally {
      budget?.resume()
    }
  }
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
      bot,
      event: env.event,
      waitForMessage,
      test: !!env.test,
    }
  }

  const step = (nodeId: string, status: RunStep['status'], edgeId?: string) => {
    try {
      env.onStep?.({ runId: trace.id, flowId: flow.doc.id, test: trace.test, nodeId, ...(edgeId ? { edgeId } : {}), status })
    } catch {}
  }

  const follow = async (id: string, exec: string | undefined) => {
    if (!exec || stopped) return
    for (const link of flow.execOut.get(`${id}|${exec}`) ?? []) {
      trace.edges.push(link.edgeId)
      await visit(link.target, link.edgeId)
    }
  }

  const visit = async (id: string, edgeId?: string): Promise<void> => {
    if (signal.aborted) throw new FlowError('The run took too long and was stopped')
    if (++steps > MAX_STEPS) throw new FlowError(`Stopped after ${MAX_STEPS} steps; check for a loop in the flow`)
    const entry = flow.nodes.get(id)
    if (entry?.type?.kind !== 'action' || !entry.ports) return
    if (entry.node.disabled) {
      const exec = entry.ports.execOut[0]
      outputs.set(id, {})
      trace.steps.push({ nodeId: id, exec, ms: 0, skipped: true })
      step(id, 'skipped', edgeId)
      if (id === env.stopAt) stopped = true
      await follow(id, exec)
      return
    }
    const started = Date.now()
    const inputs = resolveInputs(id)
    step(id, 'running', edgeId)
    let exec: string | undefined
    try {
      const result = await entry.type.run(contextFor(id, inputs))
      exec = result?.exec ?? entry.ports.execOut[0]
      outputs.set(id, result?.outputs ?? {})
      trace.steps.push({ nodeId: id, exec, ms: Date.now() - started, inputs, outputs: result?.outputs ?? {} })
      step(id, 'ok', edgeId)
    } catch (error) {
      trace.steps.push({ nodeId: id, ms: Date.now() - started, inputs, error: String((error as Error)?.message ?? error) })
      step(id, 'error', edgeId)
      throw error
    }
    if (id === env.stopAt) stopped = true
    await follow(id, exec)
  }

  const source = sourceOf(env)
  try {
    for (const id of flow.triggers) {
      if (stopped) break
      const entry = flow.nodes.get(id)!
      if (entry.type?.kind !== 'trigger' || entry.node.disabled) continue
      if ((entry.type.source ?? 'message') !== source) continue
      if (env.scheduled && env.scheduled.nodeId !== id) continue
      const started = Date.now()
      const result = entry.type.match({ config: entry.config, session, vars, event: env.event, now: env.scheduled?.now })
      if (!result) continue
      matched = true
      if (!entry.config.passThrough) consumed = true
      outputs.set(id, result)
      trace.steps.push({ nodeId: id, exec: 'next', ms: Date.now() - started, outputs: result })
      step(id, 'ok')
      if (id === env.stopAt) stopped = true
      await follow(id, 'next')
    }
  } catch (error) {
    trace.error = String((error as Error)?.message ?? error)
    env.logger.warn('flow "%s" stopped: %s', flow.doc.name, trace.error)
  } finally {
    budget?.dispose()
  }
  return { matched, consumed, trace }
}
