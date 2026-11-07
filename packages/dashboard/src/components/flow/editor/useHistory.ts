/**
 * Undo and redo for the flow editor. Every edit to the document (nodes, connections, groups and
 * the flow's own settings) is kept as a whole snapshot of it, named after what changed. The list
 * is kept in this browser for each flow, so it survives a reload, and holds at most `LIMIT` steps.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { clone } from '../../../utils'
import { BOX, type EditorState } from './state'
import type { useGroups } from './useGroups'

type FlowSnapshot = ReturnType<EditorState['toDoc']>
type SnapshotNode = FlowSnapshot['nodes'][number]
type SnapshotEdge = FlowSnapshot['edges'][number]

/** One step: the document after it, and what it did as a message key with its values. */
export interface HistoryEntry {
  doc: FlowSnapshot
  key: string
  params?: Record<string, string | number>
  /** Edits that keep going (typing, dragging) are folded into one step while they share this. */
  merge?: string
  at: number
}

interface Stored {
  entries: HistoryEntry[]
  index: number
}

/** The most steps kept for one flow; the oldest go first. */
export const LIMIT = 100
const KEY = (flowId: string) => `mushin.flows.history.${flowId}`
/** An edit is recorded once the document has been still this long, so a drag or a word is one step. */
const SETTLE = 400
/** Edits of the same thing this close together are one step. */
const MERGE_WINDOW = 2500

const sig = (doc: FlowSnapshot) => JSON.stringify(doc)

function readStored(flowId: string): Stored | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(KEY(flowId)) ?? 'null') as Stored | null
    if (!value || !Array.isArray(value.entries) || !value.entries.length) return undefined
    const index = Math.min(Math.max(0, value.index | 0), value.entries.length - 1)
    return { entries: value.entries, index }
  } catch {
    return undefined
  }
}

export function useHistory(s: EditorState, parts: { groups: ReturnType<typeof useGroups> }) {
  const entries = ref<HistoryEntry[]>([])
  const index = ref(-1)
  /** The flow the list belongs to; it is empty until the flow has loaded. */
  let owner: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const canUndo = computed(() => index.value > 0)
  const canRedo = computed(() => index.value >= 0 && index.value < entries.value.length - 1)

  function persist() {
    if (!owner) return
    let list = entries.value
    let at = index.value
    // Large flows can fill the browser's storage: keep the newer half and try again, else give up.
    for (let attempt = 0; attempt < 4 && list.length; attempt++) {
      try {
        localStorage.setItem(KEY(owner), JSON.stringify({ entries: list, index: at }))
        return
      } catch {
        const drop = Math.min(Math.ceil(list.length / 2), at)
        if (!drop) break
        list = list.slice(drop)
        at -= drop
      }
    }
    try {
      localStorage.removeItem(KEY(owner))
    } catch {}
  }

  // ---- naming a step ----

  const nodeLabel = (node: SnapshotNode) => node.label || s.typeTitle(node.type)
  const edgeKey = (edge: SnapshotEdge) => `${edge.source}|${edge.sourceHandle}|${edge.target}|${edge.targetHandle}`
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

  /** What turned `before` into `after`, as a message key, its values, and what it merges with. */
  function describe(before: FlowSnapshot, after: FlowSnapshot): Pick<HistoryEntry, 'key' | 'params' | 'merge'> {
    const was = new Map(before.nodes.map((node) => [node.id, node]))
    const now = new Map(after.nodes.map((node) => [node.id, node]))
    const added = after.nodes.filter((node) => !was.has(node.id))
    const removed = before.nodes.filter((node) => !now.has(node.id))
    const one = (list: SnapshotNode[]) => ({ name: nodeLabel(list[0]), count: list.length })
    if (added.length && removed.length) return { key: 'replaced', params: { count: added.length + removed.length } }
    if (added.length) return { key: added.length === 1 ? 'added' : 'addedMany', params: one(added) }
    if (removed.length) return { key: removed.length === 1 ? 'removed' : 'removedMany', params: one(removed) }

    const wasEdges = new Set(before.edges.map(edgeKey))
    const nowEdges = new Set(after.edges.map(edgeKey))
    const linked = after.edges.filter((edge) => !wasEdges.has(edgeKey(edge)))
    const unlinked = before.edges.filter((edge) => !nowEdges.has(edgeKey(edge)))
    const ends = (edge: SnapshotEdge) => ({ from: nodeLabel(now.get(edge.source)!), to: nodeLabel(now.get(edge.target)!) })
    if (linked.length === 1 && unlinked.length === 1) return { key: 'relinked', params: ends(linked[0]) }
    if (linked.length || unlinked.length) {
      if (linked.length + unlinked.length > 1) return { key: 'linkedMany', params: { count: linked.length + unlinked.length } }
      return linked.length ? { key: 'linked', params: ends(linked[0]) } : { key: 'unlinked', params: ends(unlinked[0]) }
    }

    const changed = after.nodes.filter((node) => !same(node, was.get(node.id)))
    const moved = changed.filter((node) => {
      const { position: _a, ...rest } = node
      const { position: _b, ...old } = was.get(node.id)!
      return same(rest, old)
    })
    if (changed.length && moved.length === changed.length) {
      const ids = moved.map((node) => node.id).sort().join(',')
      return moved.length === 1
        ? { key: 'moved', params: { name: nodeLabel(moved[0]) }, merge: `move:${ids}` }
        : { key: 'movedMany', params: { count: moved.length }, merge: `move:${ids}` }
    }
    if (changed.length === 1) {
      const node = changed[0]
      const old = was.get(node.id)!
      const name = nodeLabel(node)
      if (node.label !== old.label) return { key: 'renamedNode', params: { name: old.label || s.typeTitle(old.type), to: name }, merge: `label:${node.id}` }
      if (!!node.skip !== !!old.skip) return { key: node.skip ? 'skipped' : 'unskipped', params: { name } }
      if (node.priority !== old.priority || !same(node.intercept, old.intercept)) return { key: 'orderChanged', params: { name }, merge: `order:${node.id}` }
      return { key: 'edited', params: { name }, merge: `edit:${node.id}` }
    }
    if (changed.length) return { key: 'editedMany', params: { count: changed.length } }

    if (!same(before.groups, after.groups)) {
      const old = new Map(before.groups.map((group) => [group.id, group]))
      const groupName = (group: FlowSnapshot['groups'][number]) => group.label || s.t('flows.history.untitledGroup')
      if (after.groups.length > before.groups.length) return { key: 'grouped', params: { name: groupName(after.groups.find((group) => !old.has(group.id)) ?? after.groups[0]) } }
      if (after.groups.length < before.groups.length) return { key: 'ungrouped' }
      const group = after.groups.find((item) => !same(item, old.get(item.id)))
      if (group) {
        const prev = old.get(group.id)
        if (prev && !!prev.collapsed !== !!group.collapsed) return { key: group.collapsed ? 'collapsed' : 'expanded', params: { name: groupName(group) } }
        if (prev && prev.label !== group.label) return { key: 'renamedGroup', params: { name: groupName(group) }, merge: `group:${group.id}` }
      }
      return { key: 'groupsChanged' }
    }
    if (before.name !== after.name) return { key: 'renamedFlow', params: { name: after.name }, merge: 'name' }
    if (before.description !== after.description) return { key: 'described', merge: 'description' }
    if (before.adapter !== after.adapter || !same(before.bots, after.bots)) return { key: 'runsOn', merge: 'bots' }
    return { key: 'edited', params: { name: after.name } }
  }

  // ---- recording ----

  /** Records the document as it is now, if it changed since the current step. */
  function commit() {
    clearTimeout(timer)
    timer = undefined
    if (!owner || owner !== s.flowId.value || !s.loaded.value || index.value < 0) return
    const doc = clone(s.toDoc())
    const current = entries.value[index.value]
    if (sig(doc) === sig(current.doc)) return
    const previous = entries.value[index.value - 1]
    const step = describe(current.doc, doc)
    const now = Date.now()
    // A step still being made (the last one, not undone) takes in further edits of the same thing.
    if (step.merge && current.merge === step.merge && previous && index.value === entries.value.length - 1 && now - current.at < MERGE_WINDOW) {
      // Typed back to where the step started: the step is gone.
      if (sig(doc) === sig(previous.doc)) {
        entries.value = entries.value.slice(0, index.value)
        index.value--
      } else {
        // The name keeps the start of the step, such as the node's name before a rename.
        const params = step.key === 'renamedNode' && current.params ? { ...step.params, name: current.params.name } : step.params
        entries.value = [...entries.value.slice(0, index.value), { ...current, ...step, params, doc, at: now }]
      }
    } else {
      const list = [...entries.value.slice(0, index.value + 1), { doc, ...step, at: now }]
      entries.value = list.slice(-LIMIT)
      index.value = entries.value.length - 1
    }
    persist()
  }

  const docSignature = computed(() => (s.loaded.value ? s.signature() : ''))
  watch(docSignature, () => {
    if (!owner || index.value < 0) return
    clearTimeout(timer)
    timer = setTimeout(commit, SETTLE)
  })

  /**
   * Starts the list for the flow just loaded. A list kept from before carries on if it ends at
   * this document; otherwise the document as loaded becomes a new step after the current one, so
   * edits left unsaved last time can still be brought back.
   */
  function begin(external = false) {
    clearTimeout(timer)
    timer = undefined
    const flowId = s.flowId.value
    const doc = clone(s.toDoc())
    if (owner === flowId && index.value >= 0) {
      // The flow changed elsewhere while open.
      if (sig(entries.value[index.value].doc) === sig(doc)) return
      entries.value = [...entries.value.slice(0, index.value + 1), { doc, key: external ? 'external' : 'loaded', at: Date.now() }].slice(-LIMIT)
      index.value = entries.value.length - 1
      persist()
      return
    }
    owner = flowId
    const stored = readStored(flowId)
    if (stored && sig(stored.entries[stored.index].doc) === sig(doc)) {
      entries.value = stored.entries
      index.value = stored.index
      return
    }
    const kept = stored ? stored.entries.slice(0, stored.index + 1) : []
    entries.value = [...kept, { doc, key: kept.length ? 'loaded' : 'opened', at: Date.now() }].slice(-LIMIT)
    index.value = entries.value.length - 1
    persist()
  }

  // ---- moving through it ----

  /** Puts a snapshot back on the canvas, leaving the view, selection and run results alone. */
  function restore(doc: FlowSnapshot) {
    const copy = clone(doc)
    s.name.value = copy.name
    s.description.value = copy.description
    s.adapter.value = copy.adapter || undefined
    s.bots.value = copy.bots
    const current = new Map(s.nodes.value.map((node) => [node.id, node]))
    const real = copy.nodes.map((node) => {
      const data = {
        typeId: node.type,
        label: node.label,
        config: node.config,
        inputs: node.inputs ?? {},
        ...(node.skip ? { skip: true } : {}),
        ...(node.priority ? { priority: node.priority } : {}),
        ...(node.intercept ? { intercept: node.intercept } : {}),
      }
      const existing = current.get(node.id)
      // Keeping the canvas node keeps its measured size and selection; only what the doc holds changes.
      return existing ? { ...existing, position: node.position, data: { ...existing.data, ...data, label: node.label } } : { id: node.id, type: 'mushin', position: node.position, data }
    })
    // Boxes of collapsed groups stay where they are; syncing the groups drops the ones no longer needed.
    s.nodes.value = [...real, ...s.nodes.value.filter((node) => node.type === BOX)] as typeof s.nodes.value
    s.edges.value = copy.edges.map((edge) => ({ ...edge, ...s.edgeLook(edge) }))
    s.groups.value = copy.groups
    parts.groups.syncGroups()
    if (s.selectedId.value && !copy.nodes.some((node) => node.id === s.selectedId.value)) s.selectedId.value = undefined
  }

  /** Goes to step `target`: back with a lower number, forward with a higher one. */
  function goTo(target: number) {
    // An edit still settling is a step of its own, so undo takes it back first.
    if (timer) commit()
    if (target < 0 || target >= entries.value.length || target === index.value) return
    index.value = target
    restore(entries.value[target].doc)
    // Moving away ends the step being made: the next edit is a new one.
    entries.value = entries.value.map((entry) => (entry.merge ? { ...entry, merge: undefined } : entry))
    persist()
  }
  const undo = () => {
    if (timer) commit()
    goTo(index.value - 1)
  }
  const redo = () => goTo(index.value + 1)

  /**
   * Takes in a change that is not an edit, such as the adapter the server settles on when saving,
   * without making a step of it.
   */
  function settleHistory() {
    if (timer) commit()
    if (!owner || index.value < 0) return
    const current = entries.value[index.value]
    entries.value = [...entries.value.slice(0, index.value), { ...current, doc: clone(s.toDoc()) }, ...entries.value.slice(index.value + 1)]
    persist()
  }

  /** Forgets every step but the current one. */
  function clearHistory() {
    if (timer) commit()
    if (index.value < 0) return
    entries.value = [{ ...entries.value[index.value], key: 'cleared', params: undefined, merge: undefined }]
    index.value = 0
    persist()
  }

  /** A step's name in the current language. */
  const stepLabel = (entry: HistoryEntry) => s.t(`flows.history.steps.${entry.key}`, { ...entry.params }, typeof entry.params?.count === 'number' ? entry.params.count : 1)
  const undoLabel = computed(() => (canUndo.value ? stepLabel(entries.value[index.value]) : ''))
  const redoLabel = computed(() => (canRedo.value ? stepLabel(entries.value[index.value + 1]) : ''))

  // Leaving the editor records an edit still settling.
  onBeforeUnmount(() => timer && commit())

  return {
    historyEntries: entries, historyIndex: index, canUndo, canRedo, undoLabel, redoLabel,
    beginHistory: begin, settleHistory, undo, redo, goTo, clearHistory, stepLabel,
  }
}
