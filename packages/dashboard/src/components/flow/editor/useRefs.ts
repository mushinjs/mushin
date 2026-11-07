/**
 * What the selected node can reference, for the reference picker: outputs of the nodes that run
 * before it (object outputs opened up a level or two with the fields their latest run gave), then the
 * incoming message. Also how a written reference reads: `节点名.字段`, its latest value, and
 * whether it points at something real.
 */
import { computed } from 'vue'
import { portsOf, readPath, refOf, refsIn, SCOPES, splitName, sysPorts } from '../../../flow'
import { upstreamOf } from './checks'
import { useEditor } from './editor'

export interface RefItem {
  /** What is inserted, e.g. `{{n2.data.group_id}}`. */
  ref: string
  /** The node (or message) and field, as the picker and chips show it. */
  node: string
  field: string
  type: string
  /** The value in the latest run, shortened. */
  sample?: string
  /** That value as it is, for telling whether it suits a setting. */
  value?: unknown
}

export interface RefGroup {
  key: string
  label: string
  items: RefItem[]
}

export interface RefLook {
  label: string
  /** The reference and its latest value, or why it is wrong, for the chip's hover. */
  title: string
  invalid: boolean
}

/** How deep object outputs are opened up in the picker. */
const DEPTH = 2
/** At most this many fields of one object, so a long list does not drown the rest. */
const KEYS = 30

export function short(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return ''
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

const typeOf = (value: unknown) => (Array.isArray(value) ? 'list' : value === null ? 'null' : typeof value === 'object' ? 'object' : typeof value === 'string' ? 'text' : typeof value)

export function useRefs() {
  const { t, nodes, edges, types, runs, selectedId, nodeName, portLabel, sampleMatch, sampleTriggers } = useEditor()

  const upstream = computed(() => (selectedId.value ? upstreamOf(selectedId.value, edges.value) : new Set<string>()))

  /** The outputs a node gave in the newest run that reached it. */
  function latestOutputs(id: string) {
    for (const run of runs.value) {
      const step = run.steps.findLast((item) => item.nodeId === id)
      if (step?.outputs) return step.outputs
    }
    return sampleTriggers.value.get(id)?.outputs
  }

  /** Fields of an object value as items, `data.group_id` and so on, a level or two deep. */
  function nested(head: string, node: string, base: string, value: unknown, depth: number): RefItem[] {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > DEPTH) return []
    return Object.entries(value as Record<string, unknown>).slice(0, KEYS).flatMap(([key, item]) => {
      if (!/^[\p{L}\p{N}_-]+$/u.test(key)) return []
      const name = `${base}.${key}`
      return [
        { ref: refOf(head, name), node, field: name, type: typeOf(item), sample: short(item), value: item },
        ...nested(head, node, name, item, depth + 1),
      ]
    })
  }

  const groups = computed<RefGroup[]>(() => {
    const out: RefGroup[] = []
    for (const id of upstream.value) {
      const node = nodes.value.find((item) => item.id === id)
      const info = node && types.value.get(node.data!.typeId)
      if (!node || !info) continue
      const label = nodeName(id)
      const latest = latestOutputs(id)
      const declared = portsOf(info, node.data!.config).outputs
      const items: RefItem[] = declared.flatMap((port) => [
        { ref: refOf(id, port.name), node: label, field: port.name, type: port.type, ...(latest && port.name in latest ? { sample: short(latest[port.name]), value: latest[port.name] } : {}) },
        ...nested(id, label, port.name, latest?.[port.name], 1),
      ])
      if (items.length) out.push({ key: id, label, items })
    }
    const message = t('flows.varsMessage')
    const sys = sampleMatch.value?.sys
    out.push({
      key: 'sys',
      label: message,
      items: sysPorts.map((port) => ({ ref: refOf('sys', port.name), node: message, field: port.name, type: port.type, ...(sys && port.name in sys ? { sample: short(sys[port.name]), value: sys[port.name] } : {}) })),
    })
    return out
  })

  /** A field's name with the port's own title when it has one: `group_id`, or `回复 (reply)`. */
  function fieldTitle(head: string, name: string) {
    const { first, path } = splitName(name)
    const ports = head === 'sys' ? sysPorts : (() => {
      const node = nodes.value.find((item) => item.id === head)
      const info = node && types.value.get(node.data!.typeId)
      return info ? portsOf(info, node.data!.config).outputs : []
    })()
    const port = ports.find((item) => item.name === first)
    const title = port ? portLabel(port) : first
    return [title, ...path].join('.')
  }

  /** How a reference reads in a chip. */
  function look(text: string): RefLook {
    const [ref] = refsIn(text)
    if (!ref) return { label: text, title: text, invalid: true }
    const { first, path } = splitName(ref.name)
    if (SCOPES.includes(ref.head)) {
      return { label: `${t(`flows.refScopes.${ref.head}`)}.${ref.name}`, title: text, invalid: false }
    }
    if (ref.head === 'sys') {
      const known = sysPorts.some((port) => port.name === first)
      const value = sampleMatch.value?.sys?.[first]
      return {
        label: `${t('flows.varsMessage')}.${fieldTitle('sys', ref.name)}`,
        title: known ? [text, value === undefined ? '' : t('flows.refSample', { value: short(readPath(value, path)) })].filter(Boolean).join('\n') : t('flows.check.refNoOutput', { node: t('flows.varsMessage'), output: first }),
        invalid: !known,
      }
    }
    const node = nodes.value.find((item) => item.id === ref.head)
    if (!node) return { label: `${ref.head}.${ref.name}`, title: t('flows.check.refNoNode', { node: ref.head }), invalid: true }
    const info = types.value.get(node.data!.typeId)
    const label = `${nodeName(ref.head)}.${fieldTitle(ref.head, ref.name)}`
    if (info && !portsOf(info, node.data!.config).outputs.some((port) => port.name === first)) {
      return { label, title: t('flows.check.refNoOutput', { node: nodeName(ref.head), output: first }), invalid: true }
    }
    if (ref.head === selectedId.value) return { label, title: t('flows.check.refSelf'), invalid: true }
    if (!upstream.value.has(ref.head)) return { label, title: t('flows.check.refNotBefore', { node: nodeName(ref.head) }), invalid: true }
    const latest = latestOutputs(ref.head)
    const value = latest ? readPath(latest[first], path) : undefined
    return {
      label,
      title: [text, latest ? t('flows.refSample', { value: value === undefined ? t('flows.refNoValue') : short(value) || '""' }) : t('flows.refNotRun')].join('\n'),
      invalid: false,
    }
  }

  return { groups, look, upstream }
}
