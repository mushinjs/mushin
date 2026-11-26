import { defineStore } from 'pinia'
import { inject, type InjectionKey, ref, watch } from 'vue'
import { call, on } from '../api'
import { unwrapCall } from '../components/fairy/records'
import { ATTACH_MESSAGE, embedded, MAX_REFS, type PendingRef, refKey, wireRef } from '../components/fairy/refs'
import { prefs } from '../prefs'
import type { FairyCommands, FairyEvent, FairyGroup, FairyMessage, FairyScene, FairySessionSummary, FairySkill, FairyTaskReport, Risk, ShownRef } from '../types'

export type ToolState = 'running' | 'confirm' | 'ok' | 'error' | 'declined'

/** The action of the tool call that hands a task to a helper. */
export const DELEGATE = 'fairy.delegate'

/** A helper's task under its fairy.delegate call: its conversation, what it is doing, and an approval it waits for. */
export interface TaskView {
  session?: string
  steps: { id: string; action: string; state: ToolState }[]
  confirm?: { id: string; action: string; input: unknown }
}

export type ChatItem =
  /** `skills` are names, shown; `skillIds` the same skills, to apply them again when the message is edited or retried. */
  | { kind: 'user'; text: string; skills?: string[]; skillIds?: string[]; refs?: ShownRef[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; action: string; input: unknown; risk?: Risk; state: ToolState; result?: unknown; error?: string; task?: TaskView }
  /** `code` is `max_steps` when the reply ran out of tool rounds; the dock offers to continue. */
  | { kind: 'error'; text: string; code?: 'max_steps' }
  /** Shown by the dashboard itself, e.g. for /status; never sent to the model. */
  | { kind: 'note'; text: string }
  /** A notice from Fairy about the running turn, shown in the user's language. */
  | { kind: 'notice'; code: 'effort_ignored' }

function parseArgs(json: string) {
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}

/** A chat quoted by an older version, which kept no attachments, as the one attachment it is. */
function quotedRef(message: FairyMessage): ShownRef[] | undefined {
  const quote = message.quote
  if (!quote) return undefined
  const focus = quote.lines.find((line) => line.id === quote.focus)
  const label = focus ? `${focus.user}：${focus.text.slice(0, 40)}` : quote.channel.name ?? quote.channel.id
  return [{ kind: 'chat', id: quote.focus, label, ref: { kind: 'chat', bot: quote.bot, channel: quote.channel.id, id: quote.focus, label } }]
}

/** The chips a sent message shows for what was attached to it, each with what to send to attach it again. */
const shown = (refs: PendingRef[]): ShownRef[] => refs.map((item) => ({ kind: item.kind, ...('id' in item ? { id: item.id } : {}), label: item.label, ref: wireRef(item) }))

/** A sent message's attachment, to send again; one kept without what was sent cannot be. */
export const resendable = (item: ShownRef): PendingRef | undefined => (item.ref ? { ...item.ref, label: item.label } as PendingRef : undefined)

/** Turns a stored conversation into chat items: user and assistant text, and one row per tool call. */
function toItems(messages: FairyMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>()
  for (const message of messages) {
    if (message.role === 'user') {
      const text = message.display ?? (typeof message.content === 'string' ? message.content : '')
      const refs = message.refs ?? quotedRef(message)
      if (text || message.skills?.length || refs?.length) {
        items.push({ kind: 'user', text, ...(message.skills?.length ? { skills: message.skills, ...(message.skillIds ? { skillIds: message.skillIds } : {}) } : {}), ...(refs?.length ? { refs } : {}) })
      }
    } else if (message.role === 'assistant') {
      if (message.content) items.push({ kind: 'assistant', text: message.content })
      for (const call of message.toolCalls ?? []) {
        // A tool run through call_tool shows as itself, as it did while the reply streamed in.
        const { action, input } = unwrapCall(call.name.replaceAll('__', '.'), parseArgs(call.arguments))
        const item = { kind: 'tool' as const, id: call.id, action, input, state: 'running' as ToolState }
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
      if (item.action === DELEGATE) {
        const report = parseArgs(message.content) as Partial<FairyTaskReport>
        item.result = report
        if (report?.task) item.task = { session: report.task, steps: [] }
        if (report?.status === 'failed') item.state = 'error'
      }
    }
  }
  for (const item of tools.values()) {
    if (item.state === 'running') item.state = 'error'
  }
  return items
}

/** A question Fairy asked with ui.ask, waiting for the user's pick. */
export interface AskItem {
  id: number
  question: string
  options: { label: string; description?: string }[]
  recommended?: number
  allowOther?: boolean
  /** The conversation that asks; a question shows only with it, or under the task of a helper that asks. */
  session?: string
  resolve: (answer: unknown) => void
}

const SESSION_KEY = 'mushin.fairy.session'
const CHOICE_KEY = 'mushin.fairy.choice'
const APPROVALS_KEY = 'mushin.fairy.approvals'

/**
 * When Fairy asks before acting, picked next to the input: before any change, as the settings say, only before
 * what could do lasting harm, or never. One choice for every conversation in this browser.
 */
export type ApprovalMode = 'ask' | 'default' | 'auto' | 'full'
export const APPROVAL_MODES: ApprovalMode[] = ['ask', 'default', 'auto', 'full']

function readApprovals(): ApprovalMode {
  try {
    const value = localStorage.getItem(APPROVALS_KEY)
    return APPROVAL_MODES.includes(value as ApprovalMode) ? value as ApprovalMode : 'default'
  } catch {
    return 'default'
  }
}

const approvals = ref<ApprovalMode>(readApprovals())
watch(approvals, (value) => {
  try {
    localStorage.setItem(APPROVALS_KEY, value)
  } catch {}
})

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The model and effort picked in the dock for the next messages; empty fields use Fairy's settings. */
export interface ModelChoice {
  provider?: string
  model?: string
  effort?: Effort
}

function readChoice(): ModelChoice {
  try {
    return JSON.parse(localStorage.getItem(CHOICE_KEY) ?? '{}') ?? {}
  } catch {
    return {}
  }
}

function readSession(key: string) {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * One open conversation and what it needs: its messages, the reply streaming in, the questions and approvals
 * it waits on. The dock and the workspace's main pane share one; a split pane has its own. `pane` names it.
 */
function conversation(pane: string) {
  const sessionKey = pane === 'main' ? SESSION_KEY : `${SESSION_KEY}.${pane}`
  const open = ref(prefs.fairyOpenOnStart)
  const sessions = ref<FairySessionSummary[]>([])
  const groups = ref<FairyGroup[]>([])
  const current = ref<string | undefined>(readSession(sessionKey))
  /** Set while a helper's conversation is open: its role, and the conversation and call that started it. */
  const task = ref<{ role: string; parent: { session: string; call: string } }>()

  // Reopen the same conversation after a reload.
  watch(current, (id) => {
    try {
      if (id) localStorage.setItem(sessionKey, id)
      else localStorage.removeItem(sessionKey)
    } catch {}
  })
  const items = ref<ChatItem[]>([])
  const choice = ref<ModelChoice>(readChoice())
  watch(choice, (value) => {
    try {
      localStorage.setItem(CHOICE_KEY, JSON.stringify(value))
    } catch {}
  }, { deep: true })
  const streaming = ref('')
  const running = ref(false)
  let adopting = false

  /** Token use of the last reply in this conversation, for /status. */
  const usage = ref<{ inputTokens: number; outputTokens: number }>()
  const skills = ref<FairySkill[]>([])
  /** The open conversation's tools differ from what a new one would get (new MCP tools, changed policies). */
  const toolsStale = ref(false)
  const asks = ref<AskItem[]>([])
  let askSeq = 0
  /** What you wrote while Fairy works, until it reads it; `local` until the server gives the message an id. */
  const queued = ref<{ id: string; text: string; skills?: string[]; skillIds?: string[]; refs?: ShownRef[] }[]>([])
  /** Ids read already, for a message whose id comes back after it was read. */
  const read = new Set<string>()
  const commands = ref<FairyCommands>({ builtin: [], bots: [] })
  /** What goes with the next message for Fairy to read: picked with `@`, dragged in, or a chat message quoted. */
  const refs = ref<PendingRef[]>([])

  /** Attaches something to the next message; false when it is there already or the message holds no more. */
  function attach(item: PendingRef) {
    const key = refKey(item)
    if (refs.value.some((entry) => refKey(entry) === key) || refs.value.length >= MAX_REFS) return false
    refs.value = [...refs.value, item]
    return true
  }

  function detach(item: PendingRef) {
    refs.value = refs.value.filter((entry) => entry !== item)
  }

  async function refreshSessions() {
    const [list, groupList] = await Promise.all([call<FairySessionSummary[]>('fairy.sessions'), call<FairyGroup[]>('fairy.groups.list')])
    sessions.value = list
    groups.value = groupList
  }

  /** Renames a conversation, files it under a group (null: none), or marks it done. */
  async function updateSession(id: string, patch: { title?: string; group?: string | null; done?: boolean }) {
    await call('fairy.sessions.update', { id, ...patch })
    await refreshSessions()
  }

  /** Skills and commands for the `$` and `/` pickers. */
  async function refreshPickers() {
    const [skillList, commandList] = await Promise.all([
      call<FairySkill[]>('fairy.skills.list'),
      call<FairyCommands>('fairy.commands'),
    ])
    skills.value = skillList
    commands.value = commandList
  }

  async function load(id: string) {
    const session = await call<{ id: string; messages: FairyMessage[]; running: boolean; toolsStale?: boolean; role?: string; parent?: { session: string; call: string } }>('fairy.session', { id })
    toolsStale.value = !!session.toolsStale
    current.value = session.id
    task.value = session.role && session.parent ? { role: session.role, parent: session.parent } : undefined
    items.value = toItems(session.messages)
    queued.value = []
    running.value = session.running
    streaming.value = ''
    usage.value = undefined
  }

  function note(text: string) {
    items.value.push({ kind: 'note', text })
  }

  /**
   * Shows a ui.ask question; resolves with the user's answer. The dock stays as it is: the Fairy button and a
   * toast tell the user a question waits.
   */
  function ask(input: Omit<AskItem, 'id' | 'resolve'>) {
    return new Promise<unknown>((resolve) => {
      asks.value.push({ ...input, id: ++askSeq, resolve })
    })
  }

  /** The questions of the open conversation and of the helpers it started. */
  function visibleAsks() {
    const helpers = new Set(items.value.flatMap((item) => (item.kind === 'tool' && item.task?.session ? [item.task.session] : [])))
    return asks.value.filter((item) => !item.session || item.session === current.value || helpers.has(item.session))
  }

  function answer(id: number, result: { choice: number } | { other: string }) {
    const item = asks.value.find((entry) => entry.id === id)
    if (!item) return
    asks.value = asks.value.filter((entry) => entry !== item)
    item.resolve('choice' in result ? { choice: result.choice, label: item.options[result.choice]?.label } : result)
  }

  /** Questions nobody can answer any more, after the turn of `session` (or of any, without one) ended or was stopped. */
  function dropAsks(session?: string) {
    const gone = asks.value.filter((item) => !session || item.session === session || (!item.session && session === current.value))
    for (const item of gone) item.resolve({ cancelled: true })
    asks.value = asks.value.filter((item) => !gone.includes(item))
  }

  function newChat() {
    // Questions from conversations still running stay, for when you open them again.
    asks.value = asks.value.filter((item) => item.session || (item.resolve({ cancelled: true }), false))
    toolsStale.value = false
    current.value = undefined
    task.value = undefined
    usage.value = undefined
    items.value = []
    queued.value = []
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

  /** A helper's event, shown under the fairy.delegate call of the open conversation that started it. */
  function handleTask(event: FairyEvent) {
    const item = event.call ? tool(event.call) : undefined
    if (!item) return
    const view = item.task ??= { steps: [] }
    view.session = event.session
    const step = (id: string) => view.steps.find((entry) => entry.id === id)
    switch (event.type) {
      case 'tool-call':
        if (event.action !== 'fairy.report') view.steps.push({ id: event.id, action: event.action, state: 'running' })
        break
      case 'confirm': {
        view.confirm = { id: event.id, action: event.action, input: event.input }
        const entry = step(event.id)
        if (entry) entry.state = 'confirm'
        break
      }
      case 'confirmed': {
        const entry = step(event.id)
        if (entry?.state === 'confirm') entry.state = 'running'
        if (view.confirm?.id === event.id) view.confirm = undefined
        break
      }
      case 'tool-result': {
        const entry = step(event.id)
        if (entry) entry.state = event.ok ? 'ok' : event.error === 'Declined by the user' ? 'declined' : 'error'
        if (view.confirm?.id === event.id) view.confirm = undefined
        break
      }
      case 'done':
      case 'error':
        view.confirm = undefined
        break
    }
  }

  /** A message written during the turn, from this tab or another: shown below the work until Fairy reads it. */
  function pendingItem(id: string, text: string) {
    if (read.has(id)) return
    const local = queued.value.find((item) => item.id === 'local' && item.text === text)
    if (local) local.id = id
    else if (!queued.value.some((item) => item.id === id)) queued.value.push({ id, text })
  }

  /** Fairy read these: they take their place in the conversation, after what it did so far. */
  function markRead(ids: string[]) {
    for (const id of ids) read.add(id)
    const done = queued.value.filter((item) => ids.includes(item.id))
    if (!done.length) return
    flush()
    queued.value = queued.value.filter((item) => !done.includes(item))
    for (const { text, skills, skillIds, refs: attached } of done) {
      items.value.push({ kind: 'user', text, ...(skills ? { skills } : {}), ...(skillIds ? { skillIds } : {}), ...(attached ? { refs: attached } : {}) })
    }
  }

  /** The turn is over: whatever was written during it is in the conversation now. */
  function clearPending() {
    markRead(queued.value.map((item) => item.id))
  }

  function handle(event: FairyEvent) {
    if (event.type === 'done' || event.type === 'error') dropAsks(event.session)
    // A helper at work reading the message counts too.
    if (event.type === 'delivered' && (event.session === current.value || event.parent === current.value)) markRead(event.ids)
    if (event.parent) {
      if (event.parent === current.value) handleTask(event)
      if (event.session !== current.value) return
    }
    if (adopting && event.type === 'start' && event.session !== current.value) {
      current.value = event.session
      adopting = false
    }
    if (event.session !== current.value) return
    switch (event.type) {
      case 'start':
        running.value = true
        streaming.value = ''
        // Written as the last turn ended: it starts this one.
        markRead(queued.value.filter((item) => item.id === 'local').map((item) => item.id))
        break
      case 'queued':
        pendingItem(event.id, event.text)
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
      case 'confirmed': {
        const item = tool(event.id)
        if (item?.state === 'confirm') item.state = 'running'
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
          if (item.action === DELEGATE && event.result !== undefined) item.result = event.result
        }
        if (item.task) item.task.confirm = undefined
        break
      }
      case 'done':
        if (!streaming.value && event.text) streaming.value = event.text
        flush()
        clearPending()
        running.value = false
        if (event.usage) usage.value = event.usage
        refreshSessions().catch(() => {})
        break
      case 'notice':
        flush()
        items.value.push({ kind: 'notice', code: event.code })
        break
      case 'error':
        flush()
        items.value.push({ kind: 'error', text: event.error, ...(event.code === 'max_steps' ? { code: 'max_steps' as const } : {}) })
        clearPending()
        running.value = false
        refreshSessions().catch(() => {})
        break
    }
  }

  /** Edits the user message `ordinal` (0 is the first): what follows it goes, and the new text is sent in its place. */
  /** The skills of a sent message, as they can be picked again: ones since removed are left out. */
  function skillsOf(item: Extract<ChatItem, { kind: 'user' }>): FairySkill[] {
    const ids = item.skillIds ?? []
    return ids.flatMap((id, index) => {
      const skill = skills.value.find((entry) => entry.id === id)
      if (skill) return [skill]
      // Before the list has loaded there is nothing to check against: the server says if one is gone.
      return skills.value.length ? [] : [{ id, name: item.skills?.[index] ?? id } as FairySkill]
    })
  }

  /**
   * Replaces a sent message and what came after it. The message keeps its skills and attachments unless others
   * are given, as the edit box shows them with the ones you took off left out.
   */
  async function edit(ordinal: number, text: string, options: { scene?: FairyScene; skills?: FairySkill[]; refs?: ShownRef[] } = {}) {
    if (running.value || !current.value) return
    let seen = -1
    const at = items.value.findIndex((item) => item.kind === 'user' && ++seen === ordinal)
    const original = items.value[at]
    if (at < 0 || original?.kind !== 'user') return
    const picked = options.skills ?? skillsOf(original)
    const attached = (options.refs ?? original.refs ?? []).flatMap((item) => resendable(item) ?? [])
    if (!text.trim() && !picked.length && !attached.length) return
    items.value = items.value.slice(0, at)
    await send(text, { scene: options.scene, skills: picked, refs: attached, rewind: ordinal })
  }

  /** Sends the last user message again, replacing what came after it. */
  async function retry(options: { scene?: FairyScene } = {}) {
    let ordinal = -1
    let last: Extract<ChatItem, { kind: 'user' }> | undefined
    for (const item of items.value) {
      if (item.kind !== 'user') continue
      ordinal++
      last = item
    }
    if (!last || running.value) return
    if (current.value) return edit(ordinal, last.text, options)
    // The conversation never started, so there is nothing to rewind.
    items.value = items.value.slice(0, items.value.indexOf(last))
    return send(last.text, { ...options, skills: skillsOf(last), refs: (last.refs ?? []).flatMap((item) => resendable(item) ?? []) })
  }

  /**
   * Adds to the turn that runs: the message shows at once, marked until Fairy reads it before its next step.
   * Questions Fairy waits on are answered by it; an approval it waits on counts as declined (the server's part).
   */
  async function steer(text: string, picked: FairySkill[]) {
    const session = current.value!
    const attached = refs.value
    const entry = {
      id: 'local',
      text,
      ...(picked.length ? { skills: picked.map((skill) => skill.name), skillIds: picked.map((skill) => skill.id) } : {}),
      ...(attached.length ? { refs: shown(attached) } : {}),
    }
    queued.value.push(entry)
    refs.value = []
    try {
      const result = await call<{ session: string; queued?: string }>('fairy.send', {
        session,
        text,
        ...(picked.length ? { skills: picked.map((skill) => skill.id) } : {}),
        ...(attached.length ? { refs: attached.map(wireRef) } : {}),
      })
      // The id comes with the answer unless its event came first; without one, the turn had ended and this one ran.
      const mine = queued.value.find((item) => item === entry || (item.id === 'local' && item.text === text))
      if (mine) {
        mine.id = result.queued ?? 'ran'
        if (!result.queued || read.has(result.queued)) markRead([mine.id])
      }
    } catch (error) {
      queued.value = queued.value.filter((item) => item.text !== text || item.id !== 'local')
      items.value.push({ kind: 'error', text: (error as Error).message })
      // What was attached waits in the input again, to send once more.
      if (!refs.value.length) refs.value = attached
      return
    }
    // Sent first, so the message is there when Fairy reads the answer.
    const helpers = new Set(items.value.flatMap((item) => (item.kind === 'tool' && item.task?.session ? [item.task.session] : [])))
    for (const item of asks.value.filter((entry) => entry.session === session || (entry.session && helpers.has(entry.session)))) {
      asks.value = asks.value.filter((entry) => entry !== item)
      item.resolve({ skipped: true, note: 'The user wrote a message instead of picking; it comes next. Go by it.' })
    }
  }

  /**
   * Sends a message with the skills picked and what waits in the input; `refs` sends those instead and leaves
   * the input as it is, to send a message again.
   */
  async function send(text: string, options: { skills?: FairySkill[]; scene?: FairyScene; rewind?: number; refs?: PendingRef[] } = {}) {
    const picked = options.skills ?? []
    const fromInput = !options.refs
    const attached = options.refs ?? refs.value
    if (!text.trim() && !picked.length && !attached.length) return
    if (running.value) {
      // A new conversation has no id until its turn starts; editing waits for the turn to end.
      if (current.value && options.rewind === undefined) await steer(text, picked)
      return
    }
    items.value.push({
      kind: 'user',
      text,
      ...(picked.length ? { skills: picked.map((skill) => skill.name), skillIds: picked.map((skill) => skill.id) } : {}),
      ...(attached.length ? { refs: shown(attached) } : {}),
    })
    if (fromInput) refs.value = []
    // In place of a sent message, none means none: otherwise the server keeps the ones it had.
    const replacing = options.rewind !== undefined
    running.value = true
    adopting = !current.value
    try {
      const result = await call<{ session: string }>('fairy.send', {
        session: current.value,
        text,
        ...(options.scene ? { scene: options.scene } : {}),
        ...(picked.length || replacing ? { skills: picked.map((skill) => skill.id) } : {}),
        ...(attached.length || replacing ? { refs: attached.map(wireRef) } : {}),
        ...(choice.value.provider ? { provider: choice.value.provider } : {}),
        ...(choice.value.model ? { model: choice.value.model } : {}),
        ...(choice.value.effort ? { effort: choice.value.effort } : {}),
        ...(approvals.value !== 'default' ? { approvals: approvals.value } : {}),
        ...(options.rewind !== undefined ? { rewind: options.rewind } : {}),
      })
      current.value ??= result.session
    } catch (error) {
      items.value.push({ kind: 'error', text: (error as Error).message })
      if (fromInput && !refs.value.length) refs.value = attached
      running.value = false
      adopting = false
    }
  }

  /** Approves or declines what Fairy waits for; `then` switches the approval mode after approving this one. */
  async function confirm(id: string, approved: boolean, then?: ApprovalMode) {
    if (!current.value) return
    const item = tool(id)
    if (item) item.state = approved ? 'running' : 'declined'
    await call('fairy.confirm', { session: current.value, id, approved })
    if (then) await setApprovals(then)
  }

  /** Approves or declines what a helper waits for, from its task under the fairy.delegate call. */
  async function confirmTask(id: string, approved: boolean, then?: ApprovalMode) {
    const view = tool(id)?.task
    const pending = view?.confirm
    if (!view?.session || !pending) return
    view.confirm = undefined
    const step = view.steps.find((entry) => entry.id === pending.id)
    if (step) step.state = approved ? 'running' : 'declined'
    await call('fairy.confirm', { session: view.session, id: pending.id, approved })
    if (then) await setApprovals(then)
  }

  /**
   * Switches when Fairy asks before acting. The reply it is working on switches too, and approvals it waits on
   * that the new mode would not ask for go ahead.
   */
  async function setApprovals(mode: ApprovalMode) {
    approvals.value = mode
    if (running.value && current.value) await call('fairy.approvals', { session: current.value, mode }).catch(() => {})
  }

  async function cancel() {
    if (current.value) await call('fairy.cancel', { session: current.value })
  }

  async function remove(id: string) {
    await call('fairy.deleteSession', { id })
    if (current.value === id) newChat()
    await refreshSessions()
  }

  let bound = false
  function bind() {
    if (bound) return
    bound = true
    on('fairy/event', handle)
    // Command nodes, bots and plugin skills come and go with these.
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(() => refreshPickers().catch(() => {}), 500)
    }
    for (const name of ['flows/changed', 'bots/changed', 'actions/changed', 'fairy/changed']) on(name, later)
    let listTimer: ReturnType<typeof setTimeout> | undefined
    on('fairy/sessions', () => {
      clearTimeout(listTimer)
      listTimer = setTimeout(() => refreshSessions().catch(() => {}), 200)
    })
    on('connected', () => {
      refreshSessions().catch(() => {})
      refreshPickers().catch(() => {})
      if (current.value && !items.value.length) load(current.value).catch(() => newChat())
    })
  }

  return {
    pane, open, sessions, groups, current, task, items, queued, choice, approvals, streaming, running, usage, skills, commands, toolsStale, asks, refs, attach, detach,
    refreshSessions, updateSession, refreshPickers, load, newChat, note, ask, visibleAsks, answer, send, edit, retry, confirm, confirmTask, setApprovals, cancel, remove, bind,
  }
}

export const useFairyStore = defineStore('fairy', () => conversation('main'))

export type FairyConversation = ReturnType<typeof useFairyStore>

const panes = new Map<string, () => FairyConversation>()

/** The conversation of a workspace pane other than the main one, made the first time it is asked for. */
export function useFairyPane(pane: string): FairyConversation {
  if (pane === 'main') return useFairyStore()
  let use = panes.get(pane)
  if (!use) {
    use = defineStore(`fairy-pane-${pane}`, () => conversation(pane)) as unknown as () => FairyConversation
    panes.set(pane, use)
  }
  return use()
}

/** The conversation a component shows: the one a workspace pane provides, or the dock's. */
export const FAIRY_CONVERSATION: InjectionKey<FairyConversation> = Symbol('fairy-conversation')

export function useConversation() {
  return inject(FAIRY_CONVERSATION, null) ?? useFairyStore()
}

/**
 * Gives something on a page to Fairy, for the next message: to the conversation around the page, opening the
 * dock to show it, or to the workspace's when the page shows in its panel. False when the message holds no more.
 */
export function giveToFairy(item: PendingRef, conversation: FairyConversation) {
  if (embedded) {
    window.parent.postMessage({ type: ATTACH_MESSAGE, ref: item }, location.origin)
    return true
  }
  const added = conversation.attach(item)
  if (conversation.pane === 'main') conversation.open = true
  return added || conversation.refs.length < MAX_REFS
}

/**
 * The open conversation showing a session, or the task of a helper's session, for questions Fairy asks from it;
 * the dock's when none does (the question then waits there until that conversation is opened).
 */
export function conversationOf(session?: string): FairyConversation {
  const main = useFairyStore()
  if (!session) return main
  const all = [main, ...[...panes.values()].map((use) => use())]
  const shows = (pane: FairyConversation) => pane.current === session || pane.items.some((item) => item.kind === 'tool' && item.task?.session === session)
  return all.find(shows) ?? main
}
