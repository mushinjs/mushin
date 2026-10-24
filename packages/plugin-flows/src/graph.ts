import { z } from '@mushin/core'
import { refsIn, SCOPES } from './refs'
import type { FlowDocument, FlowIssue, FlowNode, NodeType, PortDef, PortType } from './types'

export const EXEC_IN = 'exec'
export const execOutHandle = (name: string) => `exec:${name}`

export interface NodePorts {
  execIn: boolean
  execOut: string[]
  inputs: PortDef[]
  outputs: PortDef[]
}

/** The ports a node has with a given config; classify nodes grow one exec output per label. */
export function portsOf(type: NodeType, config: Record<string, any> | undefined): NodePorts {
  if (type.kind === 'trigger') return { execIn: false, execOut: ['next'], inputs: [], outputs: type.outputs ?? [] }
  let execOut = type.execOut ?? ['next']
  if (type.execOutFrom) {
    const list = config?.[type.execOutFrom.key]
    const names = Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string' && !!item.trim()) : []
    execOut = [...names.map((name) => name.trim()), ...(type.execOutFrom.extra ?? [])]
  }
  return { execIn: true, execOut: [...new Set(execOut)], inputs: type.inputs ?? [], outputs: type.outputs ?? [] }
}

/** Whether an output of one type suits an input of another. Text accepts numbers and booleans. */
export function compatible(from: PortType, to: PortType) {
  return from === to || from === 'any' || to === 'any' || (to === 'text' && (from === 'number' || from === 'boolean'))
}

export interface CompiledNode {
  node: FlowNode
  type?: NodeType
  ports?: NodePorts
  /** Config after the node type's schema applied its defaults. */
  config: Record<string, any>
}

export interface CompiledFlow {
  doc: FlowDocument
  nodes: Map<string, CompiledNode>
  /** `${nodeId}|${execOutput}` → exec edges leaving it. */
  execOut: Map<string, { target: string; edgeId: string }[]>
  triggers: string[]
  issues: FlowIssue[]
  /** True when the flow can run: no error-level issues. */
  runnable: boolean
}

function parseHandle(handle: string) {
  if (handle === EXEC_IN) return { kind: 'exec-in' as const, name: '' }
  if (handle.startsWith('exec:')) return { kind: 'exec-out' as const, name: handle.slice(5) }
}

/** Strings in a node's config and input bindings, where references may appear. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsOf)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsOf)
  return []
}

/** Resolves node types, checks every edge and config, and builds the lookup tables the engine runs on. */
export function compile(doc: FlowDocument, types: Map<string, NodeType>): CompiledFlow {
  const issues: FlowIssue[] = []
  const nodes = new Map<string, CompiledNode>()
  const execOut: CompiledFlow['execOut'] = new Map()
  const triggers: string[] = []

  for (const node of doc.nodes) {
    if (nodes.has(node.id)) {
      issues.push({ severity: 'error', nodeId: node.id, message: `Two nodes share the id "${node.id}"` })
      continue
    }
    const type = types.get(node.type)
    if (!type) {
      issues.push({ severity: 'error', nodeId: node.id, message: `Unknown node type "${node.type}"; is the plugin that provides it enabled?` })
      nodes.set(node.id, { node, config: node.config ?? {} })
      continue
    }
    let config = node.config ?? {}
    if (type.config) {
      const result = type.config.safeParse(config)
      if (result.success) config = result.data as Record<string, any>
      else issues.push({ severity: 'error', nodeId: node.id, message: `Settings are not valid: ${z.prettifyError(result.error)}` })
    }
    nodes.set(node.id, { node, type, config, ports: portsOf(type, config) })
    if (type.kind === 'trigger') triggers.push(node.id)
  }

  for (const edge of doc.edges) {
    const source = nodes.get(edge.source)
    const target = nodes.get(edge.target)
    const from = parseHandle(edge.sourceHandle)
    const to = parseHandle(edge.targetHandle)
    const fail = (message: string) => issues.push({ severity: 'error', edgeId: edge.id, message })
    if (!source || !target) {
      fail('A connection points at a node that does not exist')
      continue
    }
    if (!source.ports || !target.ports) continue
    if (from?.kind === 'exec-out' && to?.kind === 'exec-in') {
      if (!source.ports.execOut.includes(from.name)) fail(`"${source.node.label ?? source.node.type}" has no "${from.name}" output`)
      else if (!target.ports.execIn) fail(`"${target.node.label ?? target.node.type}" does not take an execution input`)
      else {
        const key = `${edge.source}|${from.name}`
        execOut.set(key, [...(execOut.get(key) ?? []), { target: edge.target, edgeId: edge.id }])
      }
    } else {
      fail('Connections only set what runs next; pass values with variable references such as {{n1.text}}')
    }
  }

  if (!triggers.length && doc.nodes.length) {
    issues.push({ severity: 'warning', message: 'Add a trigger node; without one the flow never starts' })
  }

  // Action nodes that no trigger reaches never run.
  const reached = new Set<string>()
  const queue = [...triggers]
  while (queue.length) {
    const id = queue.shift()!
    if (reached.has(id)) continue
    reached.add(id)
    for (const name of nodes.get(id)?.ports?.execOut ?? []) {
      for (const link of execOut.get(`${id}|${name}`) ?? []) queue.push(link.target)
    }
  }
  for (const [id, entry] of nodes) {
    if (entry.type?.kind === 'action' && !reached.has(id)) {
      issues.push({ severity: 'warning', nodeId: id, message: `"${entry.node.label ?? entry.node.type}" is not connected to a trigger, so it never runs` })
    }
  }

  // References must name an output that exists; whether it ran yet is only known at run time.
  for (const [id, entry] of nodes) {
    const name = entry.node.label ?? entry.node.type
    for (const port of Object.keys(entry.node.inputs ?? {})) {
      if (entry.ports && !entry.ports.inputs.some((input) => input.name === port)) {
        issues.push({ severity: 'warning', nodeId: id, message: `"${name}" has no input "${port}"` })
      }
    }
    for (const [head, output] of stringsOf([entry.node.config, entry.node.inputs]).flatMap(refsIn)) {
      if (head === 'sys' || (SCOPES as string[]).includes(head)) continue
      const source = nodes.get(head)
      if (!source) issues.push({ severity: 'error', nodeId: id, message: `"${name}" references {{${head}.${output}}}, but there is no node "${head}"` })
      else if (source.ports && !source.ports.outputs.some((port) => port.name === output)) {
        issues.push({ severity: 'error', nodeId: id, message: `"${name}" references {{${head}.${output}}}, but "${source.node.label ?? source.node.type}" has no output "${output}"` })
      }
    }
  }

  return { doc, nodes, execOut, triggers, issues, runnable: !issues.some((issue) => issue.severity === 'error') }
}

/** Places nodes that have no position: columns by execution depth from the triggers. */
export function layout(doc: Pick<FlowDocument, 'nodes' | 'edges'>) {
  const missing = doc.nodes.filter((node) => !node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y))
  if (!missing.length) return
  const depth = new Map<string, number>()
  const execEdges = doc.edges.filter((edge) => edge.sourceHandle.startsWith('exec:'))
  const hasExecIn = new Set(execEdges.map((edge) => edge.target))
  // Start from nodes nothing runs before: triggers and unconnected nodes.
  const queue = doc.nodes.filter((node) => !hasExecIn.has(node.id)).map((node) => node.id)
  for (const id of queue) depth.set(id, 0)
  while (queue.length) {
    const id = queue.shift()!
    for (const edge of execEdges.filter((item) => item.source === id)) {
      if (depth.has(edge.target)) continue
      depth.set(edge.target, depth.get(id)! + 1)
      queue.push(edge.target)
    }
  }
  const rows = new Map<number, number>()
  for (const node of doc.nodes) {
    const column = depth.get(node.id) ?? 0
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    if (missing.includes(node)) node.position = { x: 40 + column * 300, y: 40 + row * 160 }
  }
}
