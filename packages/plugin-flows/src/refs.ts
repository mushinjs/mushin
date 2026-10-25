import { type Segment, segmentsToText } from '@mushin/core'
import type { FlowEdge, FlowNode, FlowSession, NodeType, PortDef, VariableScope } from './types'

/**
 * Variable references: `{{<node id>.<output>}}` reads an output of a node that ran earlier,
 * `{{sys.<name>}}` the incoming message, and `{{chat|user|flow|run.<name>}}` a stored variable.
 * Output and variable names may be in any script, e.g. a command argument `{{n1.分数}}`.
 */
export const REF_PATTERN = /\{\{\s*([\w-]+)\.([\p{L}\p{N}_-]+)\s*\}\}/gu
const WHOLE_REF = /^\s*\{\{\s*([\w-]+)\.([\p{L}\p{N}_-]+)\s*\}\}\s*$/u

export const SCOPES: VariableScope[] = ['chat', 'user', 'flow', 'run']

export const sysOutputs: PortDef[] = [
  { name: 'text', type: 'text', title: { en: 'Message', 'zh-CN': '消息' } },
  { name: 'user', type: 'text', title: { en: 'User name', 'zh-CN': '用户名' } },
  { name: 'userId', type: 'text', title: { en: 'User id', 'zh-CN': '用户 ID' } },
  { name: 'groupId', type: 'text', title: { en: 'Group id', 'zh-CN': '群号' } },
  { name: 'isPrivate', type: 'boolean', title: { en: 'Private chat', 'zh-CN': '是私聊' } },
  { name: 'mentioned', type: 'boolean', title: { en: 'Mentions the bot', 'zh-CN': '@ 了机器人' } },
  { name: 'message', type: 'message', title: { en: 'Message content', 'zh-CN': '消息内容' } },
]

export function sysValues(session: FlowSession): Record<string, unknown> {
  return {
    text: session.text,
    user: session.user.name ?? session.user.id,
    userId: session.user.id,
    groupId: session.isDirect ? '' : session.channel.id,
    isPrivate: session.isDirect,
    mentioned: session.mentioned,
    message: session.segments,
  }
}

/** Every reference in a string, as `[head, name]` pairs. */
export function refsIn(text: string) {
  return [...text.matchAll(REF_PATTERN)].map((match) => [match[1], match[2]] as const)
}

export function toText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((item) => item && typeof item === 'object' && 'type' in item)) {
    return segmentsToText(value as Segment[])
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/**
 * Fills references in a string. A string that is exactly one reference keeps the value's type
 * (a number stays a number); anything else becomes text.
 */
export function interpolate(text: string, lookup: (head: string, name: string) => unknown): unknown {
  const whole = WHOLE_REF.exec(text)
  if (whole) return lookup(whole[1], whole[2])
  return text.replace(REF_PATTERN, (_, head: string, name: string) => toText(lookup(head, name)))
}

/** Fills references in every string of a config value, keeping other values as they are. */
export function interpolateConfig<T>(value: T, lookup: (head: string, name: string) => unknown): T {
  if (typeof value === 'string') return (value.includes('{{') ? toText(interpolate(value, lookup)) : value) as T
  if (Array.isArray(value)) return value.map((item) => interpolateConfig(item, lookup)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateConfig(item, lookup)])) as T
  }
  return value
}

/**
 * Turns data connections from older flows into variable references: `out:a` → `in:b` becomes
 * `inputs.b = "{{source.a}}"`. Nodes that only fed data are then put on the execution path,
 * right before the first node that reads them.
 */
export function migrateDataEdges(nodes: FlowNode[], edges: FlowEdge[], types: Map<string, NodeType>) {
  const dataEdges = edges.filter((edge) => edge.sourceHandle.startsWith('out:') && edge.targetHandle.startsWith('in:'))
  if (!dataEdges.length) return { nodes, edges, changed: false }
  const byId = new Map(nodes.map((node) => [node.id, { ...node, inputs: { ...node.inputs } }]))
  for (const edge of dataEdges) {
    const target = byId.get(edge.target)
    if (target) target.inputs[edge.targetHandle.slice(3)] = `{{${edge.source}.${edge.sourceHandle.slice(4)}}}`
  }
  let next = edges.filter((edge) => !dataEdges.includes(edge))
  const isExec = (edge: FlowEdge) => edge.sourceHandle.startsWith('exec:')
  const readers = (id: string) => [...byId.values()].filter((node) => Object.values(node.inputs ?? {}).some((text) => refsIn(text).some(([head]) => head === id)))

  // Splice until stable: a spliced node may itself read another data-only node.
  for (let changed = true, guard = 0; changed && guard < nodes.length; guard++) {
    changed = false
    for (const node of byId.values()) {
      if (types.get(node.type)?.kind === 'trigger') continue
      if (next.some((edge) => isExec(edge) && (edge.source === node.id || edge.target === node.id))) continue
      const reader = readers(node.id).find((item) => next.some((edge) => isExec(edge) && edge.target === item.id))
      if (!reader) continue
      const type = types.get(node.type)
      const outs = type?.kind === 'action' ? type.execOut ?? ['next'] : ['next']
      next = next.map((edge) => (isExec(edge) && edge.target === reader.id ? { ...edge, target: node.id } : edge))
      for (const name of outs) {
        next.push({ id: `e-${node.id}-${name}-${reader.id}`, source: node.id, sourceHandle: `exec:${name}`, target: reader.id, targetHandle: 'exec' })
      }
      changed = true
    }
  }
  const migrated: FlowNode[] = [...byId.values()].map(({ inputs, ...node }) => (Object.keys(inputs).length ? { ...node, inputs } : node))
  return { nodes: migrated, edges: next, changed: true }
}
