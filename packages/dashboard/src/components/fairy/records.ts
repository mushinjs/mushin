import type { Bot, ModelProfile, Provider } from '../../types'

/**
 * Plain names for Fairy's tool calls, e.g. `bots.create` → 创建机器人, and what each one works on, so the
 * chat reads as what Fairy did rather than which function it called. The action id stays in the tooltip.
 */

type T = (key: string, ...args: any[]) => string
type Te = (key: string) => boolean

/** Verbs whose noun reads as a plural in English: "List bots", "Merge chunks". */
const PLURAL = new Set(['list', 'merge', 'generate'])

const key = (parts: string[]) => parts.join('_')

function noun(parts: string[], t: T, te: Te, count = 1) {
  const name = `fairyAction.nouns.${key(parts)}`
  return parts.length && te(name) ? t(name, count) : undefined
}

/** Chinese and Latin text get a space between them, as in 重启 MCP 服务. */
function spaced(text: string) {
  return text.replace(/([一-鿿])([A-Z0-9])/gi, '$1 $2').replace(/([A-Z0-9])([一-鿿])/gi, '$1 $2')
}

/** A tool's name in words: a name of its own, else a verb on a thing (`bots.plugins.enable`), else the id. */
export function actionLabel(action: string, t: T, te: Te): string {
  const parts = action.split('.')
  const own = `fairyAction.names.${key(parts)}`
  if (te(own)) return t(own)
  const last = parts.at(-1)!
  const verb = /^choices$|Choices$/.test(last) ? 'choices' : last
  if (parts.length > 1 && te(`fairyAction.verbs.${verb}`)) {
    const thing = noun(parts.slice(0, -1), t, te, PLURAL.has(verb) ? 2 : 1)
    if (thing) return spaced(t(`fairyAction.verbs.${verb}`, { noun: thing }))
  }
  // A thing alone, such as `bots.messages`, is looked at.
  const thing = noun(parts, t, te, 2)
  if (thing) return spaced(t('fairyAction.verbs.view', { noun: thing }))
  return action
}

export interface Known {
  bots: Bot[]
  providers: Provider[]
  profiles: ModelProfile[]
}

function clip(text: string, max = 48) {
  const line = text.split('\n')[0]!.trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * What a call works on, shown after its name: the bot or provider by its name, a name or title it was given,
 * or the words it searches for.
 */
export function actionTarget(action: string, input: unknown, known: Known): string {
  if (!input || typeof input !== 'object') return ''
  const value = input as Record<string, unknown>
  const space = action.split('.')[0]
  const id = typeof value.id === 'string' ? value.id : undefined
  if (space === 'bots') {
    const ref = id ?? (typeof value.bot === 'string' ? value.bot : undefined)
    const bot = ref ? known.bots.find((item) => item.id === ref) : undefined
    if (bot) return clip(bot.name)
  }
  if (space === 'providers' && id) {
    const found = known.providers.find((item) => item.id === id) ?? known.profiles.find((item) => item.id === id)
    if (found) return clip(found.name)
  }
  for (const field of ['name', 'title', 'label'] as const) {
    if (typeof value[field] === 'string' && value[field]) return clip(value[field] as string)
  }
  if (typeof value.query === 'string' && value.query) return `“${clip(value.query, 40)}”`
  return ''
}

/** The input and result of `call_tool`, as the tool it ran, so a stored conversation shows the real call. */
export function unwrapCall(action: string, input: unknown): { action: string; input: unknown } {
  if (action !== 'call_tool' || !input || typeof input !== 'object') return { action, input }
  const value = input as { name?: unknown; input?: unknown }
  if (typeof value.name !== 'string') return { action, input }
  return { action: value.name.includes('.') ? value.name : value.name.replaceAll('__', '.'), input: value.input ?? {} }
}

/**
 * What a call works on, for its row: what a command is for (as Fairy put it), else the command, a path, an address
 * or what is typed, else the thing it names. `code` is set when it reads as code rather than words.
 */
export function callSummary(action: string, input: unknown, known: Known): { text: string; code: boolean } {
  const value = (input ?? {}) as { purpose?: unknown; command?: unknown; path?: unknown; url?: unknown; text?: unknown; key?: unknown; ref?: unknown; query?: unknown }
  if (typeof value.purpose === 'string' && value.purpose.trim()) return { text: value.purpose.trim(), code: false }
  const code = /^(terminal|files|browser)\./.test(action)
  if (typeof value.command === 'string') return { text: `$ ${value.command.split('\n')[0]}`, code }
  if (action === 'files.search' && typeof value.query === 'string') return { text: `“${value.query}”`, code }
  if (typeof value.path === 'string' && /^(files|terminal)\./.test(action)) return { text: value.path, code }
  if (action.startsWith('browser.')) {
    if (typeof value.url === 'string') return { text: value.url, code }
    if (typeof value.text === 'string') return { text: `"${value.text.split('\n')[0]}"`, code }
    if (typeof value.key === 'string') return { text: value.key, code }
    if (typeof value.ref === 'string') return { text: value.ref, code }
  }
  if (action === 'ui.ask') return { text: '', code: false }
  return { text: actionTarget(action, input, known), code: false }
}

/** Which way a record is drawn when opened. */
export type RecordKind = 'terminal' | 'read' | 'edit' | 'write' | 'list' | 'grep' | 'browser' | 'ask' | 'tools' | 'plain'

export function recordKind(action: string): RecordKind {
  if (action === 'ui.ask') return 'ask'
  if (action === 'search_tools') return 'tools'
  if (action === 'files.read') return 'read'
  if (action === 'files.edit') return 'edit'
  if (action === 'files.write') return 'write'
  if (action === 'files.list') return 'list'
  if (action === 'files.search') return 'grep'
  if (/^terminal\.(run|start|output|write|stop)$/.test(action)) return 'terminal'
  if (action.startsWith('browser.') && action !== 'browser.frame') return 'browser'
  return 'plain'
}

/** Fields worth a line of their own in a result; the rest folds away. */
export const KEY_FIELDS = ['id', 'name', 'title', 'status', 'state', 'enabled', 'ok', 'running', 'code', 'count', 'total', 'created', 'updated', 'deleted', 'removed', 'replaced', 'path', 'url', 'model', 'provider', 'type', 'message', 'error']

/** The answer to a ui.ask question, from its result. */
export type AskAnswer =
  | { kind: 'choice'; index: number; label: string }
  | { kind: 'other'; text: string }
  | { kind: 'skipped'; note?: string }
  | { kind: 'cancelled' }

export function askAnswer(result: unknown): AskAnswer | undefined {
  if (!result || typeof result !== 'object') return undefined
  const value = result as { choice?: unknown; label?: unknown; other?: unknown; skipped?: unknown; note?: unknown; cancelled?: unknown }
  if (typeof value.choice === 'number') return { kind: 'choice', index: value.choice, label: typeof value.label === 'string' ? value.label : '' }
  if (typeof value.other === 'string') return { kind: 'other', text: value.other }
  if (value.skipped) return { kind: 'skipped', ...(typeof value.note === 'string' ? { note: value.note } : {}) }
  if (value.cancelled) return { kind: 'cancelled' }
  return undefined
}

/** A line in a code box: with its number, or marked as removed or added in a diff. */
export interface Line {
  text: string
  no?: number
  mark?: '+' | '-'
}

/** Text as numbered lines, counting from `from`. */
export function numbered(text: string, from = 1): Line[] {
  return text.split('\n').map((line, index) => ({ text: line, no: from + index }))
}

/** A replacement as a diff: the old lines removed, the new ones added. */
export function diff(before: string, after: string): Line[] {
  return [
    ...before.split('\n').map((text) => ({ text, mark: '-' as const })),
    ...(after ? after.split('\n').map((text) => ({ text, mark: '+' as const })) : []),
  ]
}
