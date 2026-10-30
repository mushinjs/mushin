import { computed, shallowRef } from 'vue'
import { call, on } from './api'
import { useDataStore } from './stores/data'
import type { AppPlugin, FlowSummary, KnowledgeSummary } from './types'

export type LogRefKind = 'bot' | 'provider' | 'profile' | 'flow' | 'plugin' | 'knowledge'

/** Something a log line names by its id, and the page that shows it. */
export interface LogRef {
  kind: LogRefKind
  id: string
  name: string
  to: string
  /**
   * Plugin ids are plain words such as `bots`, so they only count on plugin lines;
   * the generated ids of bots, flows and providers are matched on any line.
   */
  scoped?: boolean
}

const flows = shallowRef<{ id: string; name: string }[]>([])
const plugins = shallowRef<{ id: string; package: string }[]>([])
const bases = shallowRef<{ id: string; name: string }[]>([])

let bound = false
function bind() {
  if (bound) return
  bound = true
  const loadFlows = () => call<FlowSummary[]>('flows.list').then((list) => (flows.value = list)).catch(() => {})
  const loadPlugins = () => call<AppPlugin[]>('plugins.list').then((list) => (plugins.value = list)).catch(() => {})
  const loadBases = () => call<KnowledgeSummary[]>('kb.list').then((list) => (bases.value = list)).catch(() => {})
  loadFlows()
  loadPlugins()
  loadBases()
  on('flows/changed', loadFlows)
  on('manager/changed', loadPlugins)
  on('knowledge/changed', loadBases)
  on('connected', () => {
    loadFlows()
    loadPlugins()
    loadBases()
  })
}

/** Ids that log lines may mention, kept up to date with the server. */
export function useLogRefs() {
  bind()
  const data = useDataStore()
  return computed(() => {
    const map = new Map<string, LogRef>()
    const add = (ref: LogRef) => {
      if (ref.id && !map.has(ref.id)) map.set(ref.id, ref)
    }
    for (const bot of data.bots) add({ kind: 'bot', id: bot.id, name: bot.name, to: `/bots/${bot.id}` })
    for (const flow of flows.value) add({ kind: 'flow', id: flow.id, name: flow.name, to: `/flows/${flow.id}` })
    for (const provider of data.providers) add({ kind: 'provider', id: provider.id, name: provider.name, to: `/providers?highlight=${provider.id}` })
    for (const profile of data.profiles) add({ kind: 'profile', id: profile.id, name: profile.name, to: `/providers?highlight=${profile.id}` })
    for (const base of bases.value) add({ kind: 'knowledge', id: base.id, name: base.name, to: `/knowledge/${base.id}` })
    for (const plugin of plugins.value) {
      const to = `/plugins?highlight=${encodeURIComponent(plugin.package)}`
      add({ kind: 'plugin', id: plugin.id, name: plugin.package, to, scoped: true })
      add({ kind: 'plugin', id: plugin.package, name: plugin.package, to, scoped: true })
    }
    return map
  })
}

export type LogSegment = string | LogRef

const word = /[@\w][\w@/.:-]*/g
// Lines written before log lines named things by id: `"Name" (id)`.
const labelled = /"[^"\n]*" \(([\w-]+)\)/g

/** Splits a line's text into plain text and the ids it mentions. */
export function splitRefs(text: string, refs: Map<string, LogRef>, tag?: string): LogSegment[] {
  if (!refs.size) return [text]
  const plugin = tag === 'plugin'
  const find = (token: string) => {
    const ref = refs.get(token)
    return ref && (!ref.scoped || plugin) ? ref : undefined
  }
  const source = text.replace(labelled, (match, id: string) => (find(id) ? id : match))
  const segments: LogSegment[] = []
  let last = 0
  for (const match of source.matchAll(word)) {
    // Trailing dots and colons end a sentence or a label, not the id.
    const token = match[0].replace(/[.:]+$/, '')
    let ref = find(token)
    // `provider:openai`, `bot:Sq5tOOlM`: the id after the prefix.
    if (!ref && token.includes(':')) {
      const tail = token.slice(token.lastIndexOf(':') + 1)
      ref = find(tail)
      if (ref) {
        const start = match.index + token.length - tail.length
        if (start > last) segments.push(source.slice(last, start))
        segments.push(ref)
        last = start + tail.length
        continue
      }
    }
    if (!ref) continue
    if (match.index > last) segments.push(source.slice(last, match.index))
    segments.push(ref)
    last = match.index + token.length
  }
  if (last < source.length) segments.push(source.slice(last))
  return segments
}
