import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { call, on } from '../api'
import type { AgentCommands, AgentEvent, AgentMessage, AgentScene, AgentSessionSummary, AgentSkill, Risk } from '../types'

export type ToolState = 'running' | 'confirm' | 'ok' | 'error' | 'declined'

export type ChatItem =
  | { kind: 'user'; text: string; skills?: string[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; action: string; input: unknown; risk?: Risk; state: ToolState; result?: unknown; error?: string }
  | { kind: 'error'; text: string }
  /** Shown by the dashboard itself, e.g. for /status; never sent to the model. */
  | { kind: 'note'; text: string }

function parseArgs(json: string) {
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}

/** Turns a stored conversation into chat items: user and assistant text, and one row per tool call. */
function toItems(messages: AgentMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>()
  for (const message of messages) {
    if (message.role === 'user') {
      const text = message.display ?? (typeof message.content === 'string' ? message.content : '')
      if (text || message.skills?.length) items.push({ kind: 'user', text, ...(message.skills?.length ? { skills: message.skills } : {}) })
    } else if (message.role === 'assistant') {
      if (message.content) items.push({ kind: 'assistant', text: message.content })
      for (const call of message.toolCalls ?? []) {
        const item = { kind: 'tool' as const, id: call.id, action: call.name.replaceAll('__', '.'), input: parseArgs(call.arguments), state: 'running' as ToolState }
        tools.set(call.id, item)
        items.push(item)
      }
    } else if (message.role === 'tool' && message.toolCallId) {
      const item = tools.get(message.toolCallId)
      if (!item) continue
      if (message.isError) {
        item.state = /declined/i.test(message.content) ? 'declined' : 'error'
        item.error = message.content
      } else {
        item.state = 'ok'
        item.result = parseArgs(message.content)
      }
    }
  }
  for (const item of tools.values()) {
    if (item.state === 'running') item.state = 'error'
  }
  return items
}

/** A question the Agent asked with ui.ask, waiting for the user's pick. */
export interface AskItem {
  id: number
  question: string
  options: { label: string; description?: string }[]
  recommended?: number
  allowOther?: boolean
  resolve: (answer: unknown) => void
}

const SESSION_KEY = 'mushin.agent.session'

function readSession() {
  try {
    return localStorage.getItem(SESSION_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export const useAgentStore = defineStore('agent', () => {
  const open = ref(true)
  const sessions = ref<AgentSessionSummary[]>([])
  const current = ref<string | undefined>(readSession())

  // Reopen the same conversation after a reload.
  watch(current, (id) => {
    try {
      if (id) localStorage.setItem(SESSION_KEY, id)
      else localStorage.removeItem(SESSION_KEY)
    } catch {}
  })
  const items = ref<ChatItem[]>([])
  const streaming = ref('')
  const running = ref(false)
  let adopting = false

  /** Token use of the last reply in this conversation, for /status. */
  const usage = ref<{ inputTokens: number; outputTokens: number }>()
  const skills = ref<AgentSkill[]>([])
  /** The open conversation's tools differ from what a new one would get (new MCP tools, changed policies). */
  const toolsStale = ref(false)
  const asks = ref<AskItem[]>([])
  let askSeq = 0
  const commands = ref<AgentCommands>({ builtin: [], bots: [] })

  async function refreshSessions() {
    sessions.value = await call<AgentSessionSummary[]>('agent.sessions')
  }

  /** Skills and commands for the `$` and `/` pickers. */
  async function refreshPickers() {
    const [skillList, commandList] = await Promise.all([
      call<AgentSkill[]>('agent.skills.list'),
      call<AgentCommands>('agent.commands'),
    ])
    skills.value = skillList
    commands.value = commandList
  }

  async function load(id: string) {
    const session = await call<{ id: string; messages: AgentMessage[]; running: boolean; toolsStale?: boolean }>('agent.session', { id })
    toolsStale.value = !!session.toolsStale
    current.value = session.id
    items.value = toItems(session.messages)
    running.value = session.running
    streaming.value = ''
    usage.value = undefined
  }

  function note(text: string) {
    items.value.push({ kind: 'note', text })
  }

  /** Shows a ui.ask question; resolves with the user's answer. */
  function ask(input: Omit<AskItem, 'id' | 'resolve'>) {
    return new Promise<unknown>((resolve) => {
      asks.value.push({ ...input, id: ++askSeq, resolve })
      open.value = true
    })
  }

  function answer(id: number, result: { choice: number } | { other: string }) {
    const item = asks.value.find((entry) => entry.id === id)
    if (!item) return
    asks.value = asks.value.filter((entry) => entry !== item)
    item.resolve('choice' in result ? { choice: result.choice, label: item.options[result.choice]?.label } : result)
  }

  /** Questions nobody can answer any more, after the turn ended or was stopped. */
  function dropAsks() {
    for (const item of asks.value) item.resolve({ cancelled: true })
    asks.value = []
  }

  function newChat() {
    dropAsks()
    toolsStale.value = false
    current.value = undefined
    usage.value = undefined
    items.value = []
    streaming.value = ''
    running.value = false
  }

  function flush() {
    if (streaming.value.trim()) items.value.push({ kind: 'assistant', text: streaming.value })
    streaming.value = ''
  }

  function tool(id: string) {
    return items.value.find((item): item is Extract<ChatItem, { kind: 'tool' }> => item.kind === 'tool' && item.id === id)
  }

  function handle(event: AgentEvent) {
    if (adopting && event.type === 'start' && event.session !== current.value) {
      current.value = event.session
      adopting = false
    }
    if (event.session !== current.value) return
    switch (event.type) {
      case 'start':
        running.value = true
        streaming.value = ''
        break
      case 'delta':
        streaming.value += event.text
        break
      case 'tool-call':
        flush()
        items.value.push({ kind: 'tool', id: event.id, action: event.action, input: event.input, risk: event.risk, state: 'running' })
        break
      case 'confirm': {
        const item = tool(event.id)
        if (item) item.state = 'confirm'
        break
      }
      case 'tool-result': {
        const item = tool(event.id)
        if (!item) break
        if (event.ok) {
          item.state = 'ok'
          item.result = event.result
        } else {
          item.state = event.error === 'Declined by the user' ? 'declined' : 'error'
          item.error = event.error
        }
        break
      }
      case 'done':
        if (!streaming.value && event.text) streaming.value = event.text
        flush()
        running.value = false
        if (event.usage) usage.value = event.usage
        dropAsks()
        refreshSessions().catch(() => {})
        break
      case 'error':
        flush()
        items.value.push({ kind: 'error', text: event.error })
        running.value = false
        dropAsks()
        refreshSessions().catch(() => {})
        break
    }
  }

  async function send(text: string, options: { skills?: AgentSkill[]; scene?: AgentScene } = {}) {
    const picked = options.skills ?? []
    if (running.value || (!text.trim() && !picked.length)) return
    items.value.push({ kind: 'user', text, ...(picked.length ? { skills: picked.map((skill) => skill.name) } : {}) })
    running.value = true
    adopting = !current.value
    try {
      const result = await call<{ session: string }>('agent.send', {
        session: current.value,
        text,
        ...(options.scene ? { scene: options.scene } : {}),
        ...(picked.length ? { skills: picked.map((skill) => skill.id) } : {}),
      })
      current.value ??= result.session
    } catch (error) {
      items.value.push({ kind: 'error', text: (error as Error).message })
      running.value = false
      adopting = false
    }
  }

  async function confirm(id: string, approved: boolean) {
    if (!current.value) return
    const item = tool(id)
    if (item) item.state = approved ? 'running' : 'declined'
    await call('agent.confirm', { session: current.value, id, approved })
  }

  async function cancel() {
    if (current.value) await call('agent.cancel', { session: current.value })
  }

  async function remove(id: string) {
    await call('agent.deleteSession', { id })
    if (current.value === id) newChat()
    await refreshSessions()
  }

  let bound = false
  function bind() {
    if (bound) return
    bound = true
    on('agent/event', handle)
    // Command nodes, bots and plugin skills come and go with these.
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(() => refreshPickers().catch(() => {}), 500)
    }
    for (const name of ['flows/changed', 'bots/changed', 'actions/changed', 'agent/changed']) on(name, later)
    on('connected', () => {
      refreshSessions().catch(() => {})
      refreshPickers().catch(() => {})
      if (current.value && !items.value.length) load(current.value).catch(() => newChat())
    })
  }

  return {
    open, sessions, current, items, streaming, running, usage, skills, commands, toolsStale, asks,
    refreshSessions, refreshPickers, load, newChat, note, ask, answer, send, confirm, cancel, remove, bind,
  }
})
