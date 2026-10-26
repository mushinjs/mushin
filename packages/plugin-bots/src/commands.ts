/**
 * Commands such as `/score 85`: a name after a prefix, then arguments. Flows, bot plugins and the
 * built-in `/help` all register commands per bot, so help menus, the Agent and the overview can
 * list them in one place.
 */

export type CommandArgType = 'text' | 'number'

/** One argument from a signature: `<name>` is required, `[name]` optional, `<name...>` takes the rest. */
export interface CommandArg {
  name: string
  type: CommandArgType
  optional: boolean
  rest: boolean
}

export interface CommandDef {
  /** Without the prefix, e.g. `score`. */
  name: string
  aliases?: string[]
  description?: string
  /** What follows the name, e.g. `<score:number> [note]`. */
  usage?: string
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

const SIGNATURE_ARG = /<([^<>\s:.]+)(?::(\w+))?(\.\.\.)?>|\[([^[\]\s:.]+)(?::(\w+))?(\.\.\.)?\]/g

/** Reads a signature such as `<score:number> [note...]`. Unknown types count as text. */
export function parseSignature(usage: string | undefined): CommandArg[] {
  if (!usage) return []
  return [...usage.matchAll(SIGNATURE_ARG)].map((match) => {
    const optional = match[4] !== undefined
    const type = (optional ? match[5] : match[2]) === 'number' ? 'number' : 'text'
    return { name: optional ? match[4] : match[1], type, optional, rest: !!(optional ? match[6] : match[3]) }
  })
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
  | { ok: true; values: Record<string, string | number> }
  | { ok: false; error: string }

/** Fills a signature's arguments from the text after the command. */
export function parseArgs(args: CommandArg[], rest: string): ArgsResult {
  const words = rest ? rest.split(/\s+/) : []
  const values: Record<string, string | number> = {}
  for (const [index, arg] of args.entries()) {
    const takesRest = arg.rest || (index === args.length - 1 && arg.type === 'text')
    const raw = takesRest ? words.splice(0).join(' ') : words.shift() ?? ''
    if (!raw) {
      if (arg.optional) continue
      return { ok: false, error: `missing ${arg.name}` }
    }
    if (arg.type === 'number') {
      const number = Number(raw)
      if (!Number.isFinite(number)) return { ok: false, error: `${arg.name} should be a number` }
      values[arg.name] = number
    } else {
      values[arg.name] = raw
    }
  }
  return { ok: true, values }
}

/** How a command is written, e.g. `/score <score:number>`. */
export function commandUsage(def: Pick<CommandDef, 'name' | 'usage'>, prefix = DEFAULT_PREFIXES[0]) {
  return `${prefix}${def.name}${def.usage?.trim() ? ` ${def.usage.trim()}` : ''}`
}

/** The reply when a command's arguments do not fit its signature. */
export function usageReply(def: Pick<CommandDef, 'name' | 'usage'>, prefix?: string) {
  return `用法：${commandUsage(def, prefix)}`
}

/** The role a command needs, from `role` or `permission`; nothing when everyone may run it. */
export function requiredRole(def: Pick<CommandDef, 'permission' | 'role'>): 'admin' | 'master' | undefined {
  const role = def.role ?? (def.permission === 'all' ? undefined : def.permission)
  return role === 'admin' || role === 'master' ? role : undefined
}

/** The help menu for a bot's commands: one line per command, hidden ones left out. */
export function helpText(entries: CommandEntry[], settings: CommandSettings = {}) {
  const prefix = settings.prefixes?.[0] ?? DEFAULT_PREFIXES[0]
  const seen = new Set<string>()
  const lines: string[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = entry.name.toLowerCase()
    if (entry.hidden || seen.has(key)) continue
    seen.add(key)
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
