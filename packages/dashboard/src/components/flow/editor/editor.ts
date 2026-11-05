/**
 * Puts the flow editor together: the shared state and each part's behaviour, plus the keyboard
 * shortcuts and the panel layout. The view creates it once and provides it; the panels inject it.
 */
import type { Node } from '@vue-flow/core'
import { computed, inject, type InjectionKey, markRaw, onBeforeUnmount, onMounted, provide, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { categoryColors } from '../../../flow'
import { type CanvasNodeData, flowEditorKey } from '../context'
import FlowGroupBox from '../FlowGroupBox.vue'
import FlowNodeCard from '../FlowNodeCard.vue'
import { BOX, createEditorState } from './state'
import { useDocument } from './useDocument'
import { useEditing } from './useEditing'
import { useGroups } from './useGroups'
import { useMenu } from './useMenu'
import { useRuns } from './useRuns'
import { useSample } from './useSample'
import { useTriggerOrder } from './useTriggerOrder'

/** Room kept around the nodes, in canvas units: panning stops there, and the minimap shows it. */
const CANVAS_MARGIN = 480
const UNBOUNDED: [[number, number], [number, number]] = [[-Infinity, -Infinity], [Infinity, Infinity]]
/** Which side panels are open on a wide screen, kept in this browser. */
const PANELS_KEY = 'mushin.flows.panels'

function readPanels() {
  try {
    return { palette: true, panel: true, logs: true, ...JSON.parse(localStorage.getItem(PANELS_KEY) ?? '{}') }
  } catch {
    return { palette: true, panel: true, logs: true }
  }
}

export function createFlowEditor() {
  const s = createEditorState()
  const groups = useGroups(s)
  const editing = useEditing(s)
  const sample = useSample(s)
  // Test runs save pending edits first; saving comes from the document part, made further down.
  const runs = useRuns(s, { save: () => doc.save(), sample: sample.samplePayload })
  const menu = useMenu(s, groups, editing, runs)
  const order = useTriggerOrder(s, editing)
  const doc = useDocument(s, { groups, editing, runs, order })

  // Node cards read these.
  provide(flowEditorKey, {
    types: s.types,
    issuesByNode: s.issuesByNode,
    highlight: s.highlight,
    order: s.order,
    executing: s.executing,
    groups: s.groups,
    inheritedSkip: groups.inheritedSkip,
    blocked: groups.blockedNodes,
    execute: (nodeId: string) => runs.runTest(nodeId),
    nodeName: s.nodeName,
    toggleGroup: groups.toggleGroup,
    uncovered: s.uncovered,
    stepOf: runs.stepOf,
    breakpoints: s.breakpoints,
    toggleBreakpoint: runs.toggleBreakpoint,
    sampleTriggers: sample.sampleTriggers,
    hoveredHandle: s.hoveredHandle,
    linkedHandles: computed(() => s.linked.value.handles),
  })
  // Only the edges whose look changes are replaced, so hovering does not rebuild the whole canvas.
  // Replacing the edges recomputes the set, so nothing is written once every edge already matches it.
  watch(() => s.linked.value.edges, (now, before) => {
    if (![...now, ...before].some((id) => now.has(id) !== before.has(id))) return
    s.edges.value = s.edges.value.map((edge) => (now.has(edge.id) !== before.has(edge.id) ? { ...edge, ...s.edgeLook(edge) } : edge))
  })
  const nodeTypes = { mushin: markRaw(FlowNodeCard), [BOX]: markRaw(FlowGroupBox) } as any

  /** The canvas: the area the nodes take up plus a margin. Empty flows are not bounded. */
  const extent = computed<[[number, number], [number, number]]>(() => {
    const shown = s.flow.getNodes.value.filter((node) => !node.hidden)
    if (!shown.length) return UNBOUNDED
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const node of shown) {
      const { x, y } = node.computedPosition
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x + (node.dimensions.width || 240))
      y1 = Math.max(y1, y + (node.dimensions.height || 80))
    }
    return [[x0 - CANVAS_MARGIN, y0 - CANVAS_MARGIN], [x1 + CANVAS_MARGIN, y1 + CANVAS_MARGIN]]
  })

  const minimapColor = (node: Node<CanvasNodeData>) => {
    const info = s.types.value.get(node.data?.typeId ?? '')
    return info ? categoryColors[info.category] : '#8c8c8c'
  }

  // ---- panels ----

  // On a narrow screen the panels float and start closed; on a wide one they open as last left.
  watch(s.narrow, (value) => {
    const saved = readPanels()
    s.showPalette.value = !value && saved.palette
    s.showPanel.value = !value && saved.panel
    s.showLogs.value = !value && saved.logs
  }, { immediate: true })
  watch([s.showPalette, s.showPanel, s.showLogs], ([palette, panel, logs]) => {
    if (s.narrow.value) return
    try {
      localStorage.setItem(PANELS_KEY, JSON.stringify({ palette, panel, logs }))
    } catch {}
  })

  /** Opens or closes a side panel; on a narrow screen opening one closes the other. */
  function togglePalette() {
    s.showPalette.value = !s.showPalette.value
    if (s.narrow.value && s.showPalette.value) s.showPanel.value = false
  }
  function togglePanel() {
    s.showPanel.value = !s.showPanel.value
    if (s.narrow.value && s.showPanel.value) s.showPalette.value = false
  }

  const toggleImmersive = () => (s.immersive.value = !s.immersive.value)
  // Leaving the editor leaves the full window too.
  onBeforeUnmount(() => (s.immersive.value = false))

  // ---- keyboard ----

  const inTextField = (target: EventTarget | null) => !!(target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]')

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (menu.menu.value) menu.menu.value = undefined
      else if (s.immersive.value && !editing.picker.value && !inTextField(event.target)) s.immersive.value = false
    }
    // Debugger keys: F9 toggles the selected node's breakpoint; F8 continues and F10 steps a paused run.
    if (event.key === 'F9' && s.selectedId.value) {
      event.preventDefault()
      runs.toggleBreakpoint(s.selectedId.value)
      return
    }
    if ((event.key === 'F8' || event.key === 'F10') && s.paused.value) {
      event.preventDefault()
      void runs.debug(event.key === 'F8' ? 'continue' : 'step')
      return
    }
    if (!(event.ctrlKey || event.metaKey)) return
    const key = event.key.toLowerCase()
    if (key === 's') {
      event.preventDefault()
      doc.save()
      return
    }
    // Canvas shortcuts leave text fields alone.
    if (inTextField(event.target)) return
    const ids = groups.selectionIds()
    if (key === 'c' && ids.length) menu.copyNodes(ids)
    else if (key === 'v' && menu.hasClipboard()) menu.pasteNodes(editing.pointerFlowPosition())
    else if (key === 'd' && ids.length) menu.duplicateNodes(ids)
    else if (key === 'g' && event.shiftKey && ids.length) groups.ungroupNodes(ids)
    else if (key === 'g' && !event.shiftKey && ids.length > 1) groups.groupNodes(ids)
    else if (key === 'a') groups.selectAll()
    else if (key === 'enter' && event.shiftKey) toggleImmersive()
    else return
    event.preventDefault()
  }

  function onBeforeUnload(event: BeforeUnloadEvent) {
    if (s.dirty.value) event.preventDefault()
  }

  const observer = new ResizeObserver(([entry]) => (s.width.value = entry.contentRect.width))
  onMounted(() => {
    doc.reload()
    if (!s.data.loadedBots) s.data.refreshBots().catch(() => {})
    window.addEventListener('keydown', onKeydown)
    window.addEventListener('beforeunload', onBeforeUnload)
    if (s.root.value) {
      s.width.value = s.root.value.clientWidth
      observer.observe(s.root.value)
    }
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown)
    window.removeEventListener('beforeunload', onBeforeUnload)
    observer.disconnect()
  })
  onBeforeRouteLeave(() => !s.dirty.value || window.confirm(s.t('flows.unsaved')))

  const editor = {
    ...s, ...groups, ...editing, ...sample, ...runs, ...menu, ...order, ...doc,
    nodeTypes, extent, minimapColor, togglePalette, togglePanel, toggleImmersive,
  }
  provide(editorKey, editor)
  return editor
}

export type FlowEditor = ReturnType<typeof createFlowEditor>
export const editorKey: InjectionKey<FlowEditor> = Symbol('flow-editor-view')

/** The editor, for the panels inside it. */
export function useEditor() {
  const editor = inject(editorKey)
  if (!editor) throw new Error('flow editor panel used outside the flow editor')
  return editor
}
