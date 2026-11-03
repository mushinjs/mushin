/**
 * Questions about the shape of a flow that need no Vue: which steps a trigger leads to, and how a
 * run goes round skipped steps. Kept pure so they can be tested on their own.
 */

/** An edge as far as these helpers care: from one node's handle to another node. */
export interface GraphEdge {
  source: string
  sourceHandle?: string | null
  target: string
  targetHandle?: string | null
}

/** Each node's next steps, following "run next" exits only. */
export function successors(edges: GraphEdge[]) {
  const next = new Map<string, string[]>()
  for (const edge of edges) {
    if (!edge.sourceHandle?.startsWith('exec:')) continue
    next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target])
  }
  return next
}

/** The nodes reachable from `starts`, the starts included. */
export function reach(next: Map<string, string[]>, starts: string[]) {
  const seen = new Set<string>()
  const queue = [...starts]
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    queue.push(...(next.get(id) ?? []))
  }
  return seen
}

export interface TriggerInfo {
  id: string
  skip: boolean
}

/**
 * Nodes that only skipped triggers lead to: they never run. A node that another trigger still
 * reaches is left alone, and a skipped step does not pass its skip on (runs go through it).
 * Returns each such node with the id of the first skipped trigger that leads there.
 */
export function inheritedSkips(triggers: TriggerInfo[], edges: GraphEdge[]) {
  const next = successors(edges)
  const live = reach(next, triggers.filter((node) => !node.skip).map((node) => node.id))
  const result = new Map<string, string>()
  for (const trigger of triggers.filter((node) => node.skip)) {
    for (const id of reach(next, [trigger.id])) {
      if (id !== trigger.id && !live.has(id) && !result.has(id)) result.set(id, trigger.id)
    }
  }
  return result
}

/**
 * Steps that only blocked (or skipped) triggers lead to, with the blocked trigger that leads there.
 * `blocked` are triggers that never run; `skipped` are steps already known not to run.
 */
export function blockedSteps(triggers: TriggerInfo[], edges: GraphEdge[], blocked: Set<string>, skipped: Set<string>) {
  const next = successors(edges)
  const live = reach(next, triggers.filter((node) => !node.skip && !blocked.has(node.id)).map((node) => node.id))
  const result = new Map<string, string>()
  for (const trigger of triggers.filter((node) => blocked.has(node.id))) {
    for (const id of reach(next, [trigger.id])) {
      if (id === trigger.id || live.has(id) || blocked.has(id) || result.has(id) || skipped.has(id)) continue
      result.set(id, trigger.id)
    }
  }
  return result
}

export interface BypassInput {
  /** Node ids on the canvas, in order. */
  nodes: string[]
  edges: GraphEdge[]
  /** Skipped steps (never triggers). */
  skipped: (id: string) => boolean
  /** The handle of a node's first exit. */
  firstExit: (id: string) => string | undefined
  /** Nodes hidden in a collapsed group: the group's box draws for them. */
  hidden: (id: string) => boolean
}

/** A bypass to draw: from a step's exit straight to a step after the skipped ones. */
export interface Bypass {
  source: string
  sourceHandle: string
  target: string
}

/**
 * Runs pass straight through a skipped step to its first exit, so the canvas draws that path: from
 * each step that leads into a skipped one (through any skipped steps before it) to the first steps
 * after it that are not skipped. Nodes inside collapsed groups are left to the group box.
 */
export function bypasses({ nodes, edges, skipped, firstExit, hidden }: BypassInput): Bypass[] {
  if (!nodes.some(skipped)) return []
  /** The first steps that are not skipped after a skipped one, following first exits. */
  const after = (id: string, seen = new Set<string>()): string[] => {
    if (seen.has(id)) return []
    seen.add(id)
    const exit = firstExit(id)
    return edges.filter((edge) => edge.source === id && edge.sourceHandle === exit)
      .flatMap((edge) => (skipped(edge.target) ? after(edge.target, seen) : [edge.target]))
  }
  /** The exits that lead into a skipped step, through skipped steps before it. */
  const before = (id: string, seen = new Set<string>()): GraphEdge[] => {
    if (seen.has(id)) return []
    seen.add(id)
    return edges.filter((edge) => edge.target === id)
      .flatMap((edge) => (skipped(edge.source) ? (edge.sourceHandle === firstExit(edge.source) ? before(edge.source, seen) : []) : [edge]))
  }
  const drawn: Bypass[] = []
  for (const id of nodes) {
    if (!skipped(id) || hidden(id)) continue
    // Only the outermost skipped step of a chain draws, so a chain gets one bypass.
    if (edges.some((edge) => edge.target === id && skipped(edge.source))) continue
    for (const from of before(id)) {
      for (const target of after(id)) {
        if (hidden(from.source) || hidden(target)) continue
        if (edges.some((edge) => edge.source === from.source && edge.sourceHandle === from.sourceHandle && edge.target === target)) continue
        drawn.push({ source: from.source, sourceHandle: from.sourceHandle ?? '', target })
      }
    }
  }
  return drawn
}
