/**
 * Selection, groups and skipped steps: framing nodes together, folding a group into one box, and
 * drawing the canvas so skipped steps and folded groups read right.
 */
import type { Edge, GraphNode, Node } from '@vue-flow/core'
import { computed, nextTick, ref, watch } from 'vue'
import { execOutHandle, portsOf } from '../../../flow'
import type { FlowGroupDoc } from '../../../types'
import type { CanvasNodeData } from '../context'
import { blockedSteps, bypasses, inheritedSkips } from './graph'
import { BOX, BYPASS, type EditorState, isBox, isVirtual } from './state'

const GROUP_PAD = 18
const GROUP_HEAD = 28

export function useGroups(s: EditorState) {
  const { t, flow, nodes, edges, groups, realNodes, types, selectedId, tab, groupOf } = s

  /** Selected node ids: the canvas selection, or the node open in the panel. A collapsed group counts as its nodes. */
  function selectionIds() {
    const ids = flow.getSelectedNodes.value.flatMap((node) => (isBox(node) ? groupOf(node.data?.groupId)?.nodes ?? [] : [node.id]))
    return ids.length ? ids : selectedId.value ? [selectedId.value] : []
  }

  function select(ids: string[]) {
    flow.removeSelectedNodes(flow.getSelectedNodes.value)
    flow.addSelectedNodes(ids.map((id) => flow.findNode(id)).filter((node): node is GraphNode => !!node))
  }

  const selectAll = () => select(nodes.value.filter((node) => !node.hidden).map((node) => node.id))

  // A group needs two nodes that still exist; deleting nodes shrinks or removes their groups.
  watch(() => realNodes.value.map((node) => node.id).join(','), () => {
    const known = new Set(realNodes.value.map((node) => node.id))
    const next = groups.value
      .map((group) => ({ ...group, nodes: group.nodes.filter((id) => known.has(id)) }))
      .filter((group) => group.nodes.length > 1)
    if (JSON.stringify(next) !== JSON.stringify(groups.value)) groups.value = next
  })

  function groupNodes(ids: string[]) {
    if (ids.length < 2) return
    const taken = new Set(ids)
    const rest = groups.value
      .map((group) => ({ ...group, nodes: group.nodes.filter((id) => !taken.has(id)) }))
      .filter((group) => group.nodes.length > 1)
    groups.value = [...rest, { id: `g-${Math.random().toString(36).slice(2, 7)}`, label: t('flows.groupDefault'), nodes: ids }]
  }

  /** Dissolves every group that holds one of these nodes. */
  function ungroupNodes(ids: string[]) {
    groups.value = groups.value.filter((group) => !group.nodes.some((id) => ids.includes(id)))
  }

  const removeGroup = (id: string | undefined) => (groups.value = groups.value.filter((group) => group.id !== id))
  const inGroup = (ids: string[]) => groups.value.some((group) => group.nodes.some((id) => ids.includes(id)))

  const triggers = computed(() => realNodes.value
    .filter((node) => types.value.get(node.data!.typeId)?.kind === 'trigger')
    .map((node) => ({ id: node.id, skip: !!node.data!.skip })))

  /** Nodes that only skipped triggers lead to, with that trigger's name: the canvas shows them as skipped too. */
  const inheritedSkip = computed(() => new Map([...inheritedSkips(triggers.value, edges.value)].map(([id, trigger]) => [id, s.nodeName(trigger)])))

  /**
   * Triggers that certainly never run on a bot (an earlier trigger keeps the message), and the steps
   * only they, or skipped triggers, lead to. Comes from the saved flow.
   */
  const blockedNodes = computed(() => {
    const result = new Map<string, { reason: string; trigger: boolean }>()
    for (const slot of s.blockedSlots.value) {
      if (!slot.certain || result.has(slot.nodeId) || !slot.blockedBy) continue
      result.set(slot.nodeId, {
        trigger: true,
        reason: t('flows.blockedNote', { bot: s.botName(slot.botId), flow: slot.blockedBy.flowName, name: slot.blockedBy.name, priority: slot.blockedBy.priority }),
      })
    }
    if (!result.size) return result
    const steps = blockedSteps(triggers.value, edges.value, new Set(result.keys()), new Set(inheritedSkip.value.keys()))
    for (const [id, trigger] of steps) result.set(id, { trigger: false, reason: t('flows.upstreamBlockedNote', { name: s.nodeName(trigger) }) })
    return result
  })

  /** Sets the nodes to be skipped, or stops skipping them when all are skipped already. */
  function toggleSkip(ids: string[]) {
    const set = new Set(ids)
    const skip = realNodes.value.some((node) => set.has(node.id) && !node.data!.skip)
    nodes.value = nodes.value.map((node) => {
      if (!set.has(node.id) || isBox(node)) return node
      const { skip: _, ...data } = node.data!
      return { ...node, data: skip ? { ...data, skip: true } : data }
    })
    nextTick(s.restyleEdges)
  }

  /** Moves a group's nodes so their top-left corner is where the box is. */
  function followBox(group: FlowGroupDoc, box: { position: { x: number; y: number } }) {
    const members = nodes.value.filter((node) => group.nodes.includes(node.id))
    if (!members.length) return
    const dx = box.position.x - Math.min(...members.map((node) => node.position.x))
    const dy = box.position.y - Math.min(...members.map((node) => node.position.y))
    if (!dx && !dy) return
    nodes.value = nodes.value.map((node) => (group.nodes.includes(node.id) ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node))
  }

  /**
   * Collapses a group into one box, or expands it again. The box can be moved while collapsed;
   * expanding moves the group's nodes along with it.
   */
  function toggleGroup(groupId: string) {
    const group = groupOf(groupId)
    if (!group) return
    if (group.collapsed) {
      const box = nodes.value.find((node) => node.id === `group:${groupId}`)
      if (box) followBox(group, box)
    }
    groups.value = groups.value.map((item) => {
      if (item.id !== groupId) return item
      const { collapsed: _, ...rest } = item
      return group.collapsed ? rest : { ...rest, collapsed: true }
    })
    if (selectedId.value && group.nodes.includes(selectedId.value)) selectedId.value = undefined
  }

  /** A moved box takes its hidden nodes along, so the new place is saved and kept on expand. */
  function onNodeDragStop({ nodes: moved }: { nodes: GraphNode[] }) {
    for (const box of moved.filter(isBox)) {
      const group = groupOf(box.data?.groupId)
      if (group) followBox(group, box)
    }
  }

  /** Bypass edges round skipped steps, ready for the canvas. */
  function bypassEdges(real: Node<CanvasNodeData>[], realEdges: Edge[], owner: Map<string, string>): Edge[] {
    const byId = new Map(real.map((node) => [node.id, node]))
    const info = (id: string) => {
      const node = byId.get(id)
      return node && types.value.get(node.data!.typeId)
    }
    return bypasses({
      nodes: real.map((node) => node.id),
      edges: realEdges,
      skipped: (id) => !!byId.get(id)?.data?.skip && info(id)?.kind !== 'trigger',
      firstExit: (id) => {
        const type = info(id)
        return type ? execOutHandle(portsOf(type, byId.get(id)!.data!.config).execOut[0] ?? 'next') : undefined
      },
      hidden: (id) => owner.has(id),
    }).map(({ source, sourceHandle, target }) => {
      const item = {
        id: `virt:${BYPASS}${source}:${sourceHandle}:${target}`,
        source,
        sourceHandle,
        target,
        targetHandle: 'exec',
        selectable: false,
        deletable: false,
        updatable: false,
      }
      return { ...item, ...s.edgeLook(item), updatable: false } as Edge
    })
  }

  /** Puts boxes, hidden nodes and drawn-to-box connections on the canvas to match the groups. */
  function syncGroups() {
    const owner = new Map<string, string>()
    for (const group of groups.value) {
      if (group.collapsed) for (const id of group.nodes) owner.set(id, `group:${group.id}`)
    }
    const real = nodes.value
      .filter((node) => !isBox(node))
      .map((node) => (!!node.hidden === owner.has(node.id) ? node : { ...node, hidden: owner.has(node.id) }))
    const boxes: Node<CanvasNodeData>[] = groups.value.filter((group) => group.collapsed).flatMap((group) => {
      const id = `group:${group.id}`
      const members = real.filter((node) => group.nodes.includes(node.id))
      if (!members.length) return []
      const existing = nodes.value.find((node) => node.id === id)
      if (existing) return [existing]
      const position = {
        x: Math.min(...members.map((node) => node.position.x)),
        y: Math.min(...members.map((node) => node.position.y)),
      }
      return [{ id, type: BOX, position, deletable: false, data: { typeId: '', config: {}, groupId: group.id } }]
    })
    const realEdges = edges.value.filter((edge) => !isVirtual(edge))
    const seen = new Set<string>()
    const fresh = (item: Pick<Edge, 'source' | 'sourceHandle' | 'target' | 'targetHandle'>) => {
      const key = `${item.source}|${item.sourceHandle}|${item.target}|${item.targetHandle}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }
    const drawn: Edge[] = realEdges.flatMap((edge): Edge[] => {
      const from = owner.get(edge.source)
      const to = owner.get(edge.target)
      if ((!from && !to) || from === to) return []
      const item = {
        id: `virt:${edge.id}`,
        source: from ?? edge.source,
        sourceHandle: from ? 'out' : edge.sourceHandle,
        target: to ?? edge.target,
        targetHandle: to ? 'exec' : edge.targetHandle,
        selectable: false,
        deletable: false,
      }
      return fresh(item) ? [{ ...item, ...s.edgeLook(item) }] : []
    })
    drawn.push(...bypassEdges(real, realEdges, owner).filter(fresh))
    const nextNodes = [...real, ...boxes]
    const nodesChanged = nextNodes.length !== nodes.value.length || nextNodes.some((node, index) => node !== nodes.value[index])
    const nextEdges = [...realEdges, ...drawn]
    if (!nodesChanged) {
      edges.value = nextEdges
      return
    }
    // Vue Flow drops edges to nodes it has not taken in yet, and edge changes can reach it before
    // node changes in the same tick; so the canvas gets the boxes first and the edges a frame later.
    nodes.value = nextNodes
    edges.value = realEdges
    if (drawn.length) {
      requestAnimationFrame(() => (edges.value = [...edges.value.filter((edge) => !isVirtual(edge)), ...drawn]))
    }
  }

  // Re-sync when groups fold or unfold, nodes are skipped, or nodes and connections around them change.
  watch(() => JSON.stringify([
    groups.value.map((group) => [group.id, !!group.collapsed, group.nodes]),
    realNodes.value.map((node) => [node.id, !!node.data!.skip]),
    edges.value.filter((edge) => !isVirtual(edge)).map((edge) => edge.id),
  ]), syncGroups)

  function deleteNodes(ids: string[]) {
    const gone = new Set(ids)
    nodes.value = nodes.value.filter((node) => !gone.has(node.id))
    edges.value = edges.value.filter((edge) => !gone.has(edge.source) && !gone.has(edge.target))
    if (selectedId.value && gone.has(selectedId.value)) {
      selectedId.value = undefined
      tab.value = 'flow'
    }
  }

  /** Dashed frames around grouped nodes, in canvas coordinates. */
  const frames = computed(() => groups.value.flatMap((group) => {
    if (group.collapsed) return []
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const id of group.nodes) {
      const node = nodes.value.find((item) => item.id === id)
      if (!node) continue
      const size = flow.findNode(id)?.dimensions
      left = Math.min(left, node.position.x)
      top = Math.min(top, node.position.y)
      right = Math.max(right, node.position.x + (size?.width || 240))
      bottom = Math.max(bottom, node.position.y + (size?.height || 80))
    }
    if (left === Infinity) return []
    return [{
      group,
      style: {
        transform: `translate(${left - GROUP_PAD}px, ${top - GROUP_PAD - GROUP_HEAD}px)`,
        width: `${right - left + GROUP_PAD * 2}px`,
        height: `${bottom - top + GROUP_PAD * 2 + GROUP_HEAD}px`,
      },
    }]
  }))

  const renaming = ref<string>()

  /** Dragging a frame's header moves its nodes; a click selects them. */
  function startGroupDrag(event: PointerEvent, group: FlowGroupDoc) {
    if (event.button !== 0 || renaming.value === group.id) return
    const start = { x: event.clientX, y: event.clientY }
    const origin = new Map(nodes.value.filter((node) => group.nodes.includes(node.id)).map((node) => [node.id, { ...node.position }]))
    select(group.nodes)
    const move = (moved: PointerEvent) => {
      const zoom = flow.viewport.value.zoom || 1
      const dx = (moved.clientX - start.x) / zoom
      const dy = (moved.clientY - start.y) / zoom
      nodes.value = nodes.value.map((node) => {
        const from = origin.get(node.id)
        return from ? { ...node, position: { x: from.x + dx, y: from.y + dy } } : node
      })
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  function renameGroup(id: string, label: string) {
    groups.value = groups.value.map((group) => (group.id === id ? { ...group, label: label.trim() || undefined } : group))
    renaming.value = undefined
  }

  return {
    selectionIds, select, selectAll, groupNodes, ungroupNodes, removeGroup, inGroup,
    inheritedSkip, blockedNodes, toggleSkip, toggleGroup, onNodeDragStop, syncGroups, deleteNodes,
    frames, renaming, startGroupDrag, renameGroup,
  }
}
