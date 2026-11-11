/**
 * Commands such as `/score 85`: a name after a prefix, then arguments. Flows, bot plugins and the
 * built-in `/help` all register commands per bot, so help menus, the Agent and the overview can
 * list them in one place.
 */

import type { Segment } from '@mushinjs/core'

/**
 * What an argument takes: `text` a word (or the rest, for the last one), `number` a number,
 * `boolean` yes or no (是/否, true/false, on/off, 1/0), `user` an @mention or a user id, `choice` one
 * of `choices`.
 */
export type CommandArgType = 'text' | 'number' | 'boolean' | 'user' | 'choice'

/** One argument of a command, in the order they are written. */
export interface CommandArg {
  name: string
  type: CommandArgType
  /** Can be left out; then `default` is used, or the argument is missing from the values. */
  optional?: boolean
  /** Takes the rest of the message. Only text arguments can; the last text argument always does. */
  rest?: boolean
  default?: string | number | boolean
  /** For `choice` arguments. */
  choices?: string[]
  /** Shown in the usage reply and the editor. */
  description?: string
}

export type ArgValue = string | number | boolean

export interface CommandDef {
  /** Without the prefix, e.g. `score`. */
  name: string
  aliases?: string[]
  description?: string
  /** What follows the name, in order. */
  args?: CommandArg[]
  /** Prefixes of this command only, e.g. `['#']`; empty or missing uses the bot's. */
  prefixes?: string[]
  /** Left out of `/help`. */
  hidden?: boolean
  /** Who may run it: `admin` lets admins and masters, `master` only masters. Needs the permissions plugin. */
  permission?: 'all' | 'admin' | 'master'
  /** The same as `permission`, as a role: `{ role: 'admin' }`. */
  role?: 'user' | 'admin' | 'master'
}

export interface CommandSource {
  kind: 'flow' | 'plugin' | 'builtin'
  /** Flow id or plugin name. */
  id: string
  /** Flow or plugin name, for display. */
  name: string
  /** The command node, for flows. */
  nodeId?: string
}

export interface CommandEntry extends CommandDef {
  botId: string
  source: CommandSource
  /** For flow commands: higher answers first when two register the same name. */
  priority?: number
}

/** Per-bot command settings, stored on the bot record. */
export interface CommandSettings {
  /** Defaults to `['/']`. */
  prefixes?: string[]
  /** Answer `/help` with the list of commands; on unless set to false. */
  help?: boolean
  /** First line of the help menu. */
  helpTitle?: string
  /** User ids allowed to run admin-only commands. Moved to the permissions plugin, which reads it once. */
  admins?: string[]
  /** `/help` lists only the commands the asker may run. */
  helpByRole?: boolean
}

export const DEFAULT_PREFIXES = ['/']
export const DEFAULT_HELP_TITLE = '可用指令：'

/** A message split into prefix, command name and the text after it. */
export interface ParsedCommand {
  prefix: string
  /** As written, without the prefix. */
  name: string
  rest: string
  /** The registered command the name or alias belongs to, if any. */
  entry?: CommandEntry
}

/** Splits a message into a command, or nothing when it does not start with a prefix. */
export function splitCommand(text: string, prefixes: string[] = DEFAULT_PREFIXES): Omit<ParsedCommand, 'entry'> | undefined {
  const trimmed = text.trim()
  const prefix = [...prefixes].filter(Boolean).sort((a, b) => b.length - a.length).find((item) => trimmed.startsWith(item))
  if (prefix === undefined) return
  const body = trimmed.slice(prefix.length)
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body)
  if (!match) return
  return { prefix, name: match[1], rest: (match[2] ?? '').trim() }
}

/** Whether a command (by name or alias) is the one written. Names are compared without case. */
export function commandMatches(def: Pick<CommandDef, 'name' | 'aliases'>, written: string) {
  const name = written.toLowerCase()
  return [def.name, ...(def.aliases ?? [])].some((item) => !!item && item.toLowerCase() === name)
}

export type ArgsResult =
  | { ok: true; values: Record<string, ArgValue> }
  | { ok: false; error: string; arg?: string }

const YES = new Set(['是', '对', '开', '开启', 'yes', 'y', 'true', 'on', '1'])
const NO = new Set(['否', '不', '关', '关闭', 'no', 'n', 'false', 'off', '0'])

/**
 * Fills a command's arguments from the text after the command. `segments` are the message's, so an
 * @mention fills a `user` argument with the id rather than the name shown in the text.
 */
export function parseArgs(args: CommandArg[], rest: string, segments: Segment[] = []): ArgsResult {
  const mentions = segments.filter((segment) => segment.type === 'at' && segment.data.qq !== 'all')
  const words = tokenize(rest, mentions)
  const values: Record<string, ArgValue> = {}
  const lastText = args.findLastIndex((arg) => arg.type === 'text')
  for (const [index, arg] of args.entries()) {
    let word: Token | undefined
    if (arg.type === 'text' && (arg.rest || index === lastText) && index === args.length - 1) {
      const taken = words.splice(0)
      word = taken.length ? { text: taken.map((item) => item.text).join(' ') } : undefined
    } else if (arg.type === 'text' && (arg.rest || index === lastText)) {
      // Leaves one word for each argument after it.
      const later = args.length - 1 - index
      const taken = words.splice(0, Math.max(words.length - later, words.length ? 1 : 0))
      word = taken.length ? { text: taken.map((item) => item.text).join(' ') } : undefined
    } else {
      word = words.shift()
    }
    if (!word?.text) {
      if (arg.default !== undefined && arg.default !== '') values[arg.name] = arg.default
      else if (!arg.optional) return { ok: false, error: `missing ${arg.name}`, arg: arg.name }
      continue
    }
    const value = convertArg(arg, word)
    if (value === undefined) return { ok: false, error: `${arg.name} should be ${argTypeLabel(arg, 'en')}`, arg: arg.name }
    values[arg.name] = value
  }
  return { ok: true, values }
}

interface Token {
  text: string
  /** The user an @mention names. */
  user?: string
}

/** Splits text into words; `@name` words that stand for an @mention carry its user id. */
function tokenize(text: string, mentions: Segment[]): Token[] {
  const queue = [...mentions]
  return (text.trim() ? text.trim().split(/\s+/) : []).map((word) => {
    const index = queue.findIndex((segment) => word === `@${segment.data.name ?? segment.data.qq}`)
    if (index < 0) return { text: word }
    const [segment] = queue.splice(index, 1)
    return { text: word, user: String(segment.data.qq) }
  })
}

function convertArg(arg: CommandArg, word: Token): ArgValue | undefined {
  const raw = word.text
  switch (arg.type) {
    case 'number': {
      const number = Number(raw)
      return Number.isFinite(number) ? number : undefined
    }
    case 'boolean': {
      const folded = raw.toLowerCase()
      return YES.has(folded) ? true : NO.has(folded) ? false : undefined
    }
    case 'user': {
      if (word.user) return word.user
      const id = raw.replace(/^@/, '')
      return /^\d{4,}$/.test(id) ? id : undefined
    }
    case 'choice': {
      const found = (arg.choices ?? []).find((choice) => choice.toLowerCase() === raw.toLowerCase())
      return found
    }
    default:
      return raw
  }
}

/** How an argument's type reads in usage lines: `数字`, `@某人`, `a|b`. */
export function argTypeLabel(arg: Pick<CommandArg, 'type' | 'choices'>, locale: 'zh-CN' | 'en' = 'zh-CN') {
  const zh = locale === 'zh-CN'
  switch (arg.type) {
    case 'number': return zh ? '数字' : 'a number'
    case 'boolean': return zh ? '是/否' : 'yes or no'
    case 'user': return zh ? '@某人' : 'an @mention or user id'
    case 'choice': return (arg.choices ?? []).join('|') || (zh ? '选项' : 'a choice')
    default: return zh ? '文本' : 'text'
  }
}

/** The arguments as written in a usage line: `<分数:数字> [备注]`. */
export function formatArgs(args: CommandArg[] | undefined) {
  return (args ?? []).map((arg) => {
    const type = arg.type === 'text' ? '' : `:${argTypeLabel(arg)}`
    const body = `${arg.name}${type}${arg.rest ? '...' : ''}`
    return arg.optional || (arg.default !== undefined && arg.default !== '') ? `[${body}]` : `<${body}>`
  }).join(' ')
}

/** The prefix a command is shown with: its own first prefix, else the bot's. */
export function commandPrefix(def: Pick<CommandDef, 'prefixes'>, botPrefix = DEFAULT_PREFIXES[0]) {
  return def.prefixes?.find(Boolean) ?? botPrefix
}

/** How a command is written, e.g. `/score <score:数字>`. */
export function commandUsage(def: Pick<CommandDef, 'name' | 'args' | 'prefixes'>, prefix?: string) {
  const args = formatArgs(def.args)
  return `${prefix ?? commandPrefix(def)}${def.name}${args ? ` ${args}` : ''}`
}

/** The reply when a command's arguments do not fit: the usage line, then what each argument is. */
export function usageReply(def: Pick<CommandDef, 'name' | 'args' | 'prefixes'>, prefix?: string) {
  const notes = (def.args ?? []).filter((arg) => arg.description).map((arg) => `${arg.name}：${arg.description}`)
  return [`用法：${commandUsage(def, prefix)}`, ...notes].join('\n')
}

/** The role a command needs, from `role` or `permission`; nothing when everyone may run it. */
export function requiredRole(def: Pick<CommandDef, 'permission' | 'role'>): 'admin' | 'master' | undefined {
  const role = def.role ?? (def.permission === 'all' ? undefined : def.permission)
  return role === 'admin' || role === 'master' ? role : undefined
}

/** The help menu for a bot's commands: one line per command, hidden ones left out. */
export function helpText(entries: CommandEntry[], settings: CommandSettings = {}) {
  const botPrefix = settings.prefixes?.[0] ?? DEFAULT_PREFIXES[0]
  const seen = new Set<string>()
  const lines: string[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = entry.name.toLowerCase()
    if (entry.hidden || seen.has(key)) continue
    seen.add(key)
    const prefix = commandPrefix(entry, botPrefix)
    const aliases = entry.aliases?.filter(Boolean).map((alias) => `${prefix}${alias}`).join('、')
    lines.push(`${commandUsage(entry, prefix)}${aliases ? `（${aliases}）` : ''}${entry.description ? ` —— ${entry.description}` : ''}`)
  }
  return [settings.helpTitle || DEFAULT_HELP_TITLE, ...lines].join('\n')
}

/** Names (and aliases) that more than one source registers on the same bot. */
export function commandConflicts(entries: CommandEntry[]) {
  const owners = new Map<string, CommandEntry[]>()
  for (const entry of entries) {
    for (const name of new Set([entry.name, ...(entry.aliases ?? [])].filter(Boolean).map((item) => item.toLowerCase()))) {
      const key = `${entry.botId}|${name}`
      owners.set(key, [...(owners.get(key) ?? []), entry])
    }
  }
  return [...owners.entries()]
    .filter(([, list]) => list.length > 1)
    // The first entry is the one that answers: highest priority, then registration order.
    .map(([key, list]) => ({ botId: key.split('|')[0], name: key.slice(key.indexOf('|') + 1), entries: [...list].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)) }))
}
