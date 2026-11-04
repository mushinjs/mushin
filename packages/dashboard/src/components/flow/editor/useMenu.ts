/** The canvas's right-click menu, and copying and pasting nodes. */
import type { GraphNode, Node } from '@vue-flow/core'
import type { DropdownOption } from '@mushin/ui'
import { computed, nextTick, ref } from 'vue'
import { clone } from '../../../utils'
import type { CanvasNodeData } from '../context'
import { type EditorState, isBox, isVirtual } from './state'
import type { useEditing } from './useEditing'
import type { useGroups } from './useGroups'
import type { useRuns } from './useRuns'

interface Clipboard {
  nodes: { id: string; type: string; label?: string; position: { x: number; y: number }; config: Record<string, any>; inputs?: Record<string, string> }[]
  edges: { source: string; sourceHandle: string; target: string; targetHandle: string }[]
  groups: { label?: string; nodes: string[] }[]
}

const CLIPBOARD_KEY = 'mushin.flows.clipboard'

type MenuKind = 'pane' | 'node' | 'selection' | 'group' | 'edge'

export function useMenu(
  s: EditorState,
  groups: ReturnType<typeof useGroups>,
  editing: ReturnType<typeof useEditing>,
  runs: ReturnType<typeof useRuns>,
) {
  const { t, message, flow, nodes, edges, realNodes } = s

  // Kept in this browser so nodes can be pasted into another flow.
  let clipboard: Clipboard | undefined = (() => {
    try {
      return JSON.parse(localStorage.getItem(CLIPBOARD_KEY) ?? 'null') ?? undefined
    } catch {
      return undefined
    }
  })()
  const hasClipboard = () => !!clipboard

  /** The nodes, the edges between them and the groups wholly inside them. */
  function snapshot(ids: string[]): Clipboard {
    const set = new Set(ids)
    return clone({
      nodes: nodes.value.filter((node) => set.has(node.id)).map((node) => ({
        id: node.id,
        type: node.data!.typeId,
        label: node.data!.label,
        position: { ...node.position },
        config: node.data!.config,
        inputs: node.data!.inputs,
      })),
      edges: edges.value.filter((edge) => !isVirtual(edge) && set.has(edge.source) && set.has(edge.target)).map((edge) => ({
        source: edge.source, sourceHandle: edge.sourceHandle ?? '', target: edge.target, targetHandle: edge.targetHandle ?? '',
      })),
      groups: s.groups.value.filter((group) => group.nodes.every((id) => set.has(id))).map((group) => ({ label: group.label, nodes: group.nodes })),
    })
  }

  function copyNodes(ids: string[]) {
    clipboard = snapshot(ids)
    try {
      localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(clipboard))
    } catch {}
    message.success(t('flows.copied', clipboard.nodes.length))
  }

  /**
   * Adds copies with new ids, placed with their top-left node at `at` (or just below and right of
   * the originals). References between copied nodes point to the copies.
   */
  function insertCopy(copy: Clipboard, at?: { x: number; y: number }) {
    if (!copy.nodes.length) return
    const used = new Set(nodes.value.map((node) => node.id))
    const ids = new Map<string, string>()
    let index = nodes.value.length + 1
    for (const node of copy.nodes) {
      while (used.has(`n${index}`)) index++
      ids.set(node.id, `n${index}`)
      used.add(`n${index}`)
    }
    const remap = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)
      .replace(/\{\{(\s*)([\w-]+)\./g, (whole, space: string, head: string) => (ids.has(head) ? `{{${space}${ids.get(head)}.` : whole)))
    const minX = Math.min(...copy.nodes.map((node) => node.position.x))
    const minY = Math.min(...copy.nodes.map((node) => node.position.y))
    const dx = at ? at.x - minX : 40
    const dy = at ? at.y - minY : 40
    const added: Node<CanvasNodeData>[] = copy.nodes.map((node) => ({
      id: ids.get(node.id)!,
      type: 'mushin',
      position: { x: node.position.x + dx, y: node.position.y + dy },
      data: { typeId: node.type, label: node.label, config: remap(node.config) ?? {}, inputs: remap(node.inputs) ?? undefined },
    }))
    const links = copy.edges.map((edge) => s.link(ids.get(edge.source)!, edge.sourceHandle, ids.get(edge.target)!, edge.targetHandle))
    nodes.value = [...nodes.value, ...added]
    edges.value = [...edges.value, ...links]
    s.groups.value = [...s.groups.value, ...copy.groups.map((group) => ({
      id: `g-${Math.random().toString(36).slice(2, 7)}`, label: group.label, nodes: group.nodes.map((id) => ids.get(id)!),
    }))]
    nextTick(() => groups.select(added.map((node) => node.id)))
  }

  const pasteNodes = (at?: { x: number; y: number }) => clipboard && insertCopy(clipboard, at)
  const duplicateNodes = (ids: string[]) => insertCopy(snapshot(ids))

  const menu = ref<{ x: number; y: number; kind: MenuKind; target?: string; ids: string[]; at: { x: number; y: number } }>()
  editing.whenPickerOpens(() => (menu.value = undefined))

  // The right button's own mouseup can land outside the menu it just opened; that is not a click away.
  let menuOpenedAt = 0

  function openMenu(event: MouseEvent | TouchEvent, kind: MenuKind, target?: string, ids: string[] = []) {
    event.preventDefault()
    const point = 'touches' in event ? event.touches[0] ?? event.changedTouches[0] : event
    editing.picker.value = undefined
    menuOpenedAt = Date.now()
    menu.value = { x: point.clientX, y: point.clientY, kind, target, ids, at: editing.toFlow(point.clientX, point.clientY) }
  }

  function onMenuClickOutside() {
    if (Date.now() - menuOpenedAt > 250) menu.value = undefined
  }

  function onNodeContextMenu({ event, node }: { event: MouseEvent | TouchEvent; node: GraphNode }) {
    if (isBox(node)) {
      const group = s.groupOf(node.data?.groupId)
      if (group) openMenu(event, 'group', group.id, group.nodes)
      return
    }
    const selection = flow.getSelectedNodes.value.map((item) => item.id)
    if (selection.length > 1 && selection.includes(node.id)) openMenu(event, 'selection', undefined, selection)
    else {
      groups.select([node.id])
      s.selectedId.value = node.id
      openMenu(event, 'node', node.id, [node.id])
    }
  }

  const menuOptions = computed<DropdownOption[]>(() => {
    const current = menu.value
    if (!current) return []
    const divider = (key: string): DropdownOption => ({ type: 'divider', key })
    const { kind, ids } = current
    if (kind === 'pane') {
      return [
        { key: 'add', label: t('flows.menuAddNode') },
        { key: 'paste', label: t('flows.menuPaste'), disabled: !clipboard },
        divider('d1'),
        { key: 'selectAll', label: t('flows.menuSelectAll'), disabled: !nodes.value.length },
        { key: 'fit', label: t('flows.menuFitView') },
      ]
    }
    if (kind === 'edge') {
      return [
        { key: 'insert', label: t('flows.menuInsertNode') },
        { key: 'deleteEdge', label: t('flows.menuDeleteEdge'), danger: true },
      ]
    }
    if (kind === 'group') {
      const collapsed = !!s.groupOf(current.target)?.collapsed
      return [
        { key: 'toggleGroup', label: collapsed ? t('flows.menuExpand') : t('flows.menuCollapse') },
        { key: 'rename', label: t('flows.menuRenameGroup'), disabled: collapsed },
        { key: 'copy', label: t('flows.menuCopy') },
        { key: 'duplicate', label: t('flows.menuDuplicate') },
        divider('d1'),
        { key: 'ungroup', label: t('flows.menuUngroup') },
        { key: 'delete', label: t('flows.menuDeleteGroup'), danger: true },
      ]
    }
    const allSkipped = ids.every((id) => realNodes.value.find((node) => node.id === id)?.data?.skip)
    return [
      ...(kind === 'node' ? [{ key: 'execute', label: t('flows.executeStep'), disabled: s.testing.value }] : []),
      ...(kind === 'node' && current.target ? [{ key: 'breakpoint', label: s.breakpoints.value.has(current.target) ? t('flows.menuRemoveBreakpoint') : t('flows.menuBreakpoint') }] : []),
      { key: 'toggleSkip', label: allSkipped ? t('flows.menuUnskip') : t('flows.menuSkip') },
      ...(kind === 'selection' ? [{ key: 'group', label: t('flows.menuGroup') }] : []),
      ...(groups.inGroup(ids) ? [{ key: 'ungroup', label: t('flows.menuUngroup') }] : []),
      divider('d1'),
      { key: 'copy', label: t('flows.menuCopy') },
      { key: 'duplicate', label: t('flows.menuDuplicate') },
      divider('d2'),
      { key: 'delete', label: t('flows.menuDelete'), danger: true },
    ]
  })

  function onMenuSelect(key: string) {
    const current = menu.value
    menu.value = undefined
    if (!current) return
    const { ids, target, at } = current
    switch (key) {
      case 'add': return editing.openPicker(current.x, current.y, at, {})
      case 'paste': return pasteNodes(at)
      case 'selectAll': return groups.selectAll()
      case 'fit': return flow.fitView({ padding: 0.2, maxZoom: 1.2 })
      case 'execute': return target && runs.runTest(target)
      case 'breakpoint': return target && runs.toggleBreakpoint(target)
      case 'group': return groups.groupNodes(ids)
      case 'ungroup': return current.kind === 'group' ? groups.removeGroup(target) : groups.ungroupNodes(ids)
      case 'rename': return (groups.renaming.value = target)
      case 'toggleGroup': return target && groups.toggleGroup(target)
      case 'toggleSkip': return groups.toggleSkip(ids)
      case 'copy': return copyNodes(ids)
      case 'duplicate': return duplicateNodes(ids)
      case 'delete': return groups.deleteNodes(ids)
      case 'deleteEdge': return (edges.value = edges.value.filter((edge) => edge.id !== target))
      case 'insert': return editing.openPicker(current.x, current.y, at, { insert: target })
    }
  }

  return { hasClipboard, copyNodes, pasteNodes, duplicateNodes, menu, openMenu, onMenuClickOutside, onNodeContextMenu, menuOptions, onMenuSelect }
}
