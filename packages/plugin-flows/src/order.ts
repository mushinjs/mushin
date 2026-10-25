import { commandName } from './nodes'
import { type CompiledFlow, type CompiledNode, passesOn, triggerPriority } from './graph'
import type { TriggerSource } from './types'

/** A trigger's place in its bot's order: higher priority first, then older flows, then canvas order. */
export interface TriggerSlot {
  flowId: string
  flowName: string
  nodeId: string
  /** The node's number in its flow, as the editor shows it (1-based). */
  number: number
  /** The node's label, or a summary such as `/checkin`. */
  name: string
  type: string
  source: TriggerSource
  priority: number
  /** After it runs, later triggers and plugins still see the message. */
  passesOn: boolean
  /** An earlier trigger that answers first and keeps the message from this one. */
  blockedBy?: { flowId: string; flowName: string; nodeId: string; name: string; priority: number }
  /** `true`: it never runs on this bot. `false`: it may not, depending on the message. */
  certain?: boolean
}

const lower = (items: unknown) => (Array.isArray(items) ? items.map((item) => String(item).trim().toLowerCase()).filter(Boolean) : [])

const commandNames = (entry: CompiledNode) => [commandName(entry.config.name), ...lower(entry.config.aliases).map(commandName)]
  .map((item) => item.toLowerCase())
  .filter(Boolean)

/** A short description of what a trigger listens for, e.g. `/checkin` or `hello, hi`. */
export function triggerSummary(entry: CompiledNode) {
  const config = entry.config
  switch (entry.node.type) {
    case 'trigger.command': return `/${commandName(config.name)}`
    case 'trigger.keyword': return lower(config.keywords).join(', ')
    case 'trigger.regex': return `/${config.pattern}/`
    case 'trigger.message': return String(config.when ?? 'any')
    default: return ''
  }
}

const sameConfig = (a: Record<string, any>, b: Record<string, any>) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Whether a message (or event) that starts `later` always, or only sometimes, starts `earlier`
 * too. Used to find triggers that an earlier, non-passing trigger keeps from ever running.
 */
export function overlap(earlier: CompiledNode, later: CompiledNode): 'always' | 'maybe' | undefined {
  const source = (entry: CompiledNode) => (entry.type?.kind === 'trigger' ? entry.type.source ?? 'message' : undefined)
  if (!source(earlier) || source(earlier) !== source(later)) return
  const a = earlier.config
  const b = later.config
  if (source(earlier) !== 'message') {
    if (earlier.node.type !== later.node.type) return
    return sameConfig(a, b) ? 'always' : 'maybe'
  }
  const types = `${earlier.node.type}>${later.node.type}`
  if (earlier.node.type === 'trigger.message') {
    if (a.when === 'any' || (later.node.type === 'trigger.message' && a.when === b.when)) return 'always'
    return 'maybe'
  }
  if (types === 'trigger.command>trigger.command') {
    const mine = new Set(commandNames(earlier))
    const theirs = commandNames(later)
    if (!theirs.some((name) => mine.has(name))) return
    // An admin-only command lets other people's messages through.
    const all = theirs.every((name) => mine.has(name)) && (a.permission !== 'admin' || b.permission === 'admin')
    return all ? 'always' : 'maybe'
  }
  if (types === 'trigger.keyword>trigger.keyword') {
    const mine = lower(a.keywords)
    const theirs = lower(b.keywords)
    if (!theirs.length) return
    const exact = a.mode === 'exact' && b.mode === 'exact' && a.ignoreCase === b.ignoreCase
    if (exact && theirs.every((word) => mine.includes(word))) return 'always'
    const hits = theirs.some((word) => mine.some((own) => (a.mode === 'exact' ? word === own : a.mode === 'startsWith' ? word.startsWith(own) : word.includes(own))))
    return hits ? 'maybe' : undefined
  }
  if (types === 'trigger.regex>trigger.regex') {
    return a.pattern === b.pattern && a.flags === b.flags ? 'always' : undefined
  }
  if (types === 'trigger.keyword>trigger.command') {
    const names = commandNames(later)
    return lower(a.keywords).some((word) => names.some((name) => `/${name}`.startsWith(word) || (a.mode === 'contains' && `/${name}`.includes(word)))) ? 'maybe' : undefined
  }
  if (types === 'trigger.command>trigger.keyword') {
    const names = commandNames(earlier)
    return lower(b.keywords).some((word) => names.some((name) => word.startsWith(`/${name}`))) ? 'maybe' : undefined
  }
  return undefined
}

/**
 * Every trigger of the flows that run on one bot, in the order a message reaches them, with the
 * earlier trigger that keeps each one from running, if any. Skipped triggers are left out.
 */
export function triggerOrder(flows: CompiledFlow[]): TriggerSlot[] {
  const entries = flows.flatMap((flow, flowIndex) => flow.triggers.flatMap((nodeId, index) => {
    const entry = flow.nodes.get(nodeId)!
    if (entry.node.skip || entry.type?.kind !== 'trigger') return []
    return [{ flow, entry, flowIndex, index }]
  }))
  entries.sort((x, y) => triggerPriority(y.entry) - triggerPriority(x.entry) || x.flowIndex - y.flowIndex || x.index - y.index)
  return entries.map(({ flow, entry }, position) => {
    const slot: TriggerSlot = {
      flowId: flow.doc.id,
      flowName: flow.doc.name,
      nodeId: entry.node.id,
      number: flow.doc.nodes.findIndex((node) => node.id === entry.node.id) + 1,
      name: entry.node.label || triggerSummary(entry) || entry.node.type,
      type: entry.node.type,
      source: entry.type?.kind === 'trigger' ? entry.type.source ?? 'message' : 'message',
      priority: triggerPriority(entry),
      passesOn: passesOn(entry),
    }
    let maybe: (typeof entries)[number] | undefined
    for (const before of entries.slice(0, position)) {
      if (passesOn(before.entry)) continue
      const kind = overlap(before.entry, entry)
      if (kind === 'always') {
        maybe = before
        slot.certain = true
        break
      }
      if (kind === 'maybe') maybe ??= before
    }
    if (maybe) {
      slot.blockedBy = {
        flowId: maybe.flow.doc.id,
        flowName: maybe.flow.doc.name,
        nodeId: maybe.entry.node.id,
        name: maybe.entry.node.label || triggerSummary(maybe.entry) || maybe.entry.node.type,
        priority: triggerPriority(maybe.entry),
      }
      slot.certain ??= false
    }
    return slot
  })
}
