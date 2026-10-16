import {
  type ActionInfo, Context, field, fromToolName, MushinError, randomId, Service, toToolName, z,
} from '@mushin/core'
import type { LlmMessage, LlmResult, ToolCall, ToolDefinition } from '@mushin/plugin-providers'
import type {} from '@mushin/plugin-storage'
import { contextNote, SYSTEM_PROMPT, type TurnContext } from './prompt'

export * from './prompt'

declare module '@mushin/core' {
  interface Context {
    agent: Agent
  }

  interface Events {
    'agent/event'(event: AgentEvent): void
  }
}

export type AgentEvent = { session: string } & (
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'tool-call'; id: string; action: string; input: unknown; risk: string }
  | { type: 'confirm'; id: string; action: string; input: unknown }
  | { type: 'tool-result'; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'done'; text: string; usage?: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; error: string }
)

/** A stored message; `display` holds the user's own words when the content carries a context note. */
export type AgentMessage = LlmMessage & { display?: string; at: number }

export interface AgentSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Tool list frozen at creation, so every request in the session sends identical tools. */
  tools: ToolDefinition[]
  messages: AgentMessage[]
}

export interface SendOptions {
  /** Dashboard connection id; client actions such as ui.navigate are routed back to it. */
  client?: string
  page?: string
}

const MAX_RESULT_CHARS = 16_000

export const Config = z.object({
  provider: z.string().optional().meta(field('Provider', 'Provider id for the Agent; empty uses the default provider', {
    'zh-CN': { title: '提供商', description: '智能体使用的提供商 id；留空使用默认提供商' },
  })),
  model: z.string().optional().meta(field('Model', 'Model for the Agent; empty uses the provider\'s default', {
    'zh-CN': { title: '模型', description: '智能体使用的模型；留空使用提供商默认模型' },
  })),
  maxSteps: z.number().int().min(1).max(50).default(12).meta(field('Max steps', 'Most tool-calling rounds in one reply', {
    'zh-CN': { title: '最大步数', description: '一次回复中最多调用工具的轮数' },
  })),
  confirmTimeout: z.number().int().min(10).default(600).meta(field('Approval timeout', 'Seconds to wait for approval of a dangerous action', {
    'zh-CN': { title: '确认超时', description: '等待用户批准危险操作的秒数' },
  })),
})

export type Config = z.infer<typeof Config>

interface Running {
  abort: AbortController
  confirms: Map<string, (approved: boolean) => void>
}

/** Runs conversations in which the LLM operates Mushin.js through the action registry. */
export class Agent extends Service {
  static inject = ['actions', 'llm', 'storage']
  static Config = Config

  private home: Context
  private running = new Map<string, Running>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agent')
    this.home = ctx
  }

  *[Service.init]() {
    yield* this.defineActions()
    yield () => {
      for (const id of this.running.keys()) this.cancel(id)
    }
  }

  /** Tools offered to the model: every action except the Agent's own. */
  tools(): ToolDefinition[] {
    return this.home.actions.list()
      .filter((action) => !action.name.startsWith('agent.'))
      .map((action) => ({
        name: toToolName(action.name),
        description: describeTool(action),
        parameters: action.inputSchema,
      }))
  }

  private emit(event: AgentEvent) {
    this.home.emit('agent/event', event)
  }

  async sessions() {
    const keys = await this.home.storage.list('agent')
    const sessions = await Promise.all(keys.map((key) => this.home.storage.get<AgentSession>(key)))
    return sessions
      .filter((session): session is AgentSession => !!session)
      .map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt, running: this.running.has(id) }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async session(id: string) {
    const session = await this.home.storage.get<AgentSession>(`agent/${id}`)
    if (!session) throw new MushinError('not_found', `No Agent session "${id}"`)
    return session
  }

  async createSession(): Promise<AgentSession> {
    const now = Date.now()
    const session: AgentSession = { id: randomId(), title: '', createdAt: now, updatedAt: now, tools: this.tools(), messages: [] }
    await this.save(session)
    return session
  }

  async deleteSession(id: string) {
    this.cancel(id)
    await this.home.storage.delete(`agent/${id}`)
    return { deleted: id }
  }

  private save(session: AgentSession) {
    session.updatedAt = Date.now()
    return this.home.storage.set(`agent/${session.id}`, session)
  }

  private turnContext(page?: string): TurnContext {
    const providers = this.home.llm.list()
    const bots = this.home.get('bots')?.list() ?? []
    return {
      page,
      providers: providers.length,
      ready: this.home.llm.isReady(),
      bots: bots.length,
      online: bots.filter((bot: { status: string }) => bot.status === 'online').length,
    }
  }

  /** Starts a turn and returns once it finishes. Progress streams as `agent/event` events. */
  async send(sessionId: string | undefined, text: string, options: SendOptions = {}) {
    if (!this.home.llm.list().length) {
      throw new MushinError('unavailable', 'Add an LLM provider before using the Agent')
    }
    const session = sessionId ? await this.session(sessionId) : await this.createSession()
    if (this.running.has(session.id)) throw new MushinError('conflict', 'The Agent is still working on this conversation')
    const running: Running = { abort: new AbortController(), confirms: new Map() }
    this.running.set(session.id, running)
    if (!session.title) session.title = text.replace(/\s+/g, ' ').slice(0, 48)
    session.messages.push({
      role: 'user',
      content: `${contextNote(this.turnContext(options.page))}\n\n${text}`,
      display: text,
      at: Date.now(),
    })
    await this.save(session)
    this.emit({ session: session.id, type: 'start' })
    try {
      const final = await this.loop(session, running, options)
      this.emit({ session: session.id, type: 'done', text: final?.text ?? '', usage: final?.usage })
    } catch (error) {
      const message = running.abort.signal.aborted ? 'Stopped' : error instanceof Error ? error.message : String(error)
      this.emit({ session: session.id, type: 'error', error: message })
    } finally {
      this.running.delete(session.id)
      await this.save(session)
    }
    return { session: session.id }
  }

  private async loop(session: AgentSession, running: Running, options: SendOptions) {
    let last: LlmResult | undefined
    for (let step = 0; step < this.config.maxSteps; step++) {
      const history: LlmMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...session.messages.map(stripMeta)]
      let result: LlmResult | undefined
      for await (const event of this.home.llm.stream({
        provider: this.config.provider,
        model: this.config.model,
        messages: history,
        tools: session.tools,
        signal: running.abort.signal,
      })) {
        if (event.type === 'delta') this.emit({ session: session.id, type: 'delta', text: event.text })
        else if (event.type === 'result') result = event.result
      }
      if (!result) throw new Error('The provider returned no result')
      last = result
      session.messages.push({
        role: 'assistant',
        content: result.text,
        ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
        ...(result.raw ? { raw: result.raw } : {}),
        at: Date.now(),
      })
      if (!result.toolCalls.length) return result

      // A tool call cut off by the output limit, or in a refused turn, may be truncated: never run it.
      if (result.finishReason === 'length' || result.finishReason === 'refusal') {
        const reason = result.finishReason === 'length'
          ? 'The reply hit the output limit, so this tool call may be incomplete and was not run.'
          : 'The model declined this turn, so this tool call was not run.'
        for (const call of result.toolCalls) {
          session.messages.push({ role: 'tool', toolCallId: call.id, content: reason, isError: true, at: Date.now() })
        }
        throw new Error(reason)
      }

      for (const call of result.toolCalls) {
        await this.runTool(session, running, call, options)
      }
      await this.save(session)
    }
    throw new Error(`Stopped after ${this.config.maxSteps} tool rounds; send another message to continue`)
  }

  private async runTool(session: AgentSession, running: Running, call: ToolCall, options: SendOptions) {
    const name = fromToolName(call.name)
    const info = this.home.actions.get(name)
    const reply = (content: string, isError = false) => {
      session.messages.push({ role: 'tool', toolCallId: call.id, content, ...(isError ? { isError } : {}), at: Date.now() })
    }

    let input: unknown
    try {
      input = JSON.parse(call.arguments || '{}')
    } catch {
      this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: false, error: 'Arguments are not valid JSON' })
      return reply('The arguments were not valid JSON. Send a JSON object that matches the tool schema.', true)
    }
    if (!info) {
      this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: false, error: `Unknown tool ${call.name}` })
      return reply(`The tool ${call.name} is not available right now.`, true)
    }

    this.emit({ session: session.id, type: 'tool-call', id: call.id, action: name, input, risk: info.risk })

    if (info.risk === 'dangerous') {
      this.emit({ session: session.id, type: 'confirm', id: call.id, action: name, input })
      const approved = await this.waitForApproval(running, call.id)
      if (!approved) {
        this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: false, error: 'Declined by the user' })
        return reply('The user declined this action. Do not retry it.', true)
      }
    }

    try {
      const result = await this.home.actions.call(name, input, { kind: 'agent', session: session.id, client: options.client })
      this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: true, result })
      reply(truncate(JSON.stringify(result ?? { ok: true })))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ session: session.id, type: 'tool-result', id: call.id, ok: false, error: message })
      reply(`Error: ${message}`, true)
    }
  }

  private waitForApproval(running: Running, callId: string) {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), this.config.confirmTimeout * 1000)
      const finish = (approved: boolean) => {
        clearTimeout(timer)
        running.confirms.delete(callId)
        resolve(approved)
      }
      running.confirms.set(callId, finish)
      running.abort.signal.addEventListener('abort', () => finish(false), { once: true })
    })
  }

  confirm(sessionId: string, callId: string, approved: boolean) {
    const resolve = this.running.get(sessionId)?.confirms.get(callId)
    if (!resolve) throw new MushinError('not_found', 'No action is waiting for approval')
    resolve(approved)
    return { ok: true }
  }

  cancel(sessionId: string) {
    const running = this.running.get(sessionId)
    if (!running) return { ok: false }
    running.abort.abort()
    return { ok: true }
  }

  status() {
    return { ready: this.home.llm.isReady(), providers: this.home.llm.list().length, running: [...this.running.keys()] }
  }

  private *defineActions() {
    const actions = this.home.actions

    yield actions.define({
      name: 'agent.status',
      description: 'Whether the Agent can run (a provider exists and passed its test).',
      risk: 'read',
      input: z.object({}),
      handler: () => this.status(),
    })

    yield actions.define({
      name: 'agent.sessions',
      description: 'List Agent conversations, newest first.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.sessions(),
    })

    yield actions.define({
      name: 'agent.session',
      description: 'Get one Agent conversation with its messages.',
      risk: 'read',
      input: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        const { tools, ...session } = await this.session(id)
        return { ...session, messages: session.messages.map(({ raw, ...message }: any) => message), running: this.running.has(id) }
      },
    })

    yield actions.define({
      name: 'agent.send',
      description: 'Send a message to the Agent. Omit session to start a new conversation. Progress streams over the WebSocket.',
      risk: 'write',
      input: z.object({ session: z.string().optional(), text: z.string().min(1), page: z.string().optional() }),
      handler: ({ session, text, page }, caller) => this.send(session, text, { client: caller.client, page }),
    })

    yield actions.define({
      name: 'agent.confirm',
      description: 'Approve or decline an action the Agent is waiting on.',
      risk: 'write',
      input: z.object({ session: z.string(), id: z.string(), approved: z.boolean() }),
      handler: ({ session, id, approved }) => this.confirm(session, id, approved),
    })

    yield actions.define({
      name: 'agent.cancel',
      description: 'Stop the Agent\'s current reply in a conversation.',
      risk: 'write',
      input: z.object({ session: z.string() }),
      handler: ({ session }) => this.cancel(session),
    })

    yield actions.define({
      name: 'agent.deleteSession',
      description: 'Delete an Agent conversation.',
      risk: 'write',
      input: z.object({ id: z.string() }),
      handler: ({ id }) => this.deleteSession(id),
    })
  }
}

function describeTool(action: ActionInfo) {
  const notes: string[] = []
  if (action.risk === 'dangerous') notes.push('Dangerous: the user must approve it.')
  if (action.client) notes.push('Runs in the user\'s dashboard; fails if none is connected.')
  return [action.description, ...notes].join(' ')
}

function stripMeta(message: AgentMessage): LlmMessage {
  const { display, at, ...rest } = message
  return rest as LlmMessage
}

function truncate(text: string) {
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${text.slice(0, MAX_RESULT_CHARS)}… [truncated ${text.length - MAX_RESULT_CHARS} characters; ask for less, e.g. with a filter or limit]`
}

export default Agent
