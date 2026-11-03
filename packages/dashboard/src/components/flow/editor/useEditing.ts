/**
 * Changing the graph by hand: adding nodes (from the palette, by dropping them, or from the picker
 * that opens where a connection is dropped), connecting and reconnecting them, and editing the
 * node open in the panel.
 */
import type { Connection, Edge, Node, OnConnectStartParams } from '@vue-flow/core'
import { computed, nextTick, ref } from 'vue'
import { execOutHandle, parseHandle, portsOf, schemaDefaults, supports } from '../../../flow'
import type { NodeTypeInfo } from '../../../types'
import type { CanvasNodeData } from '../context'
import { type EditorState, isBox, isVirtual } from './state'

interface PickerTarget {
  /** Connect from (source) or to (target) this handle. */
  connect?: OnConnectStartParams
  /** Put the node in the middle of this edge. */
  insert?: string
}

export function useEditing(s: EditorState) {
  const { t, flow, nodes, edges, types, selectedId, selected, tab, canvas, narrow } = s

  // Vue Flow also checks the edges it is given against this, including those drawn to a collapsed
  // group's box; the box's handles cannot be dragged, so users never connect to it themselves.
  function isValidConnection(connection: Connection) {
    if (connection.source === connection.target) return false
    const fromBox = connection.source.startsWith('group:')
    const toBox = connection.target.startsWith('group:')
    return (fromBox ? connection.sourceHandle === 'out' : parseHandle(connection.sourceHandle)?.kind === 'exec-out')
      && (toBox ? connection.targetHandle === 'exec' : parseHandle(connection.targetHandle)?.kind === 'exec-in')
  }

  // Dragging an end of a connection moves it to another handle; dropping it on empty canvas removes it.
  let edgeMoved = false
  /** Set while an existing connection's end is dragged, so dropping it does not offer new nodes. */
  let updatingEdge = false

  function onEdgeUpdateStart() {
    edgeMoved = false
    updatingEdge = true
  }

  function onEdgeUpdate({ edge, connection }: { edge: Edge; connection: Connection }) {
    if (isVirtual(edge) || !isValidConnection(connection)) return
    if (connection.source.startsWith('group:') || connection.target.startsWith('group:')) return
    edgeMoved = true
    edges.value = edges.value.map((item) => {
      if (item.id !== edge.id) return item
      const next = { ...item, source: connection.source, sourceHandle: connection.sourceHandle ?? '', target: connection.target, targetHandle: connection.targetHandle ?? '' }
      return { ...next, ...s.edgeLook(next) }
    })
  }

  function onEdgeUpdateEnd({ edge }: { edge: Edge }) {
    requestAnimationFrame(() => (updatingEdge = false))
    if (edgeMoved || isVirtual(edge)) return
    edges.value = edges.value.filter((item) => item.id !== edge.id)
  }

  /** The connection being drawn from a handle, so dropping it on empty canvas can offer nodes. */
  let dragged: OnConnectStartParams | undefined

  function onConnect(connection: Connection) {
    dragged = undefined
    if (connection.source.startsWith('group:') || connection.target.startsWith('group:')) return
    if (!isValidConnection(connection)) return
    if (edges.value.some((edge) => edge.source === connection.source && edge.sourceHandle === connection.sourceHandle
      && edge.target === connection.target && edge.targetHandle === connection.targetHandle)) return
    edges.value = [...edges.value, s.link(connection.source, connection.sourceHandle ?? '', connection.target, connection.targetHandle ?? '')]
  }

  function nextNodeId() {
    const used = new Set(nodes.value.map((node) => node.id))
    let index = nodes.value.length + 1
    while (used.has(`n${index}`)) index++
    return `n${index}`
  }

  function addNode(typeId: string, position?: { x: number; y: number }) {
    const info = types.value.get(typeId)
    if (!info || !supports(info, s.currentAdapter.value)) return
    let at = position
    if (!at) {
      const rect = canvas.value?.getBoundingClientRect()
      const jitter = (nodes.value.length % 5) * 24
      at = flow.project({ x: (rect?.width ?? 800) / 2 - 110 + jitter, y: (rect?.height ?? 600) / 2 - 60 + jitter })
    }
    const id = nextNodeId()
    nodes.value = [...nodes.value, { id, type: 'mushin', position: at, data: { typeId, config: schemaDefaults(info.configSchema) } }]
    s.selectNode(id)
    s.openPanel()
    return id
  }

  function onDrop(event: DragEvent) {
    const typeId = event.dataTransfer?.getData('application/mushin-node')
    const rect = canvas.value?.getBoundingClientRect()
    if (!typeId || !rect) return
    addNode(typeId, flow.project({ x: event.clientX - rect.left - 110, y: event.clientY - rect.top - 20 }))
  }

  function onNodeClick({ node }: { node: Node }) {
    if (isBox(node)) return
    s.selectNode(node.id)
    s.logs.value?.showNode(node.id)
    if (narrow.value) s.openPanel()
  }

  /** Selects a node, opens its settings and centers the canvas on it. */
  function focusNode(id: string, animate = true) {
    s.selectNode(id)
    if (narrow.value) s.openPanel()
    const node = flow.findNode(id)
    if (!node) return
    flow.addSelectedNodes([node])
    const x = node.computedPosition.x + (node.dimensions.width || 240) / 2
    const y = node.computedPosition.y + (node.dimensions.height || 80) / 2
    flow.setCenter(x, y, { zoom: Math.max(flow.viewport.value.zoom, 0.9), duration: animate ? 300 : 0 })
  }

  /** Replaces a node's data; when its ports change (e.g. classify labels), drops edges to ports that are gone. */
  async function updateSelected(patch: Partial<CanvasNodeData>) {
    const node = selected.value
    if (!node) return
    const next = { ...node.data!, ...patch }
    nodes.value = nodes.value.map((item) => (item.id === node.id ? { ...item, data: next } : item))
    const info = types.value.get(next.typeId)
    if (info) {
      const ports = portsOf(info, next.config)
      const handles = new Set([
        ...(ports.execIn ? ['exec'] : []),
        ...ports.execOut.map((name) => `exec:${name}`),
      ])
      edges.value = edges.value.filter((edge) => (edge.source !== node.id || handles.has(edge.sourceHandle ?? ''))
        && (edge.target !== node.id || handles.has(edge.targetHandle ?? '')))
    }
    await nextTick()
    flow.updateNodeInternals([node.id])
  }

  function deleteSelected() {
    const id = selectedId.value
    if (!id) return
    nodes.value = nodes.value.filter((node) => node.id !== id)
    edges.value = edges.value.filter((edge) => edge.source !== id && edge.target !== id)
    selectedId.value = undefined
    tab.value = 'flow'
  }

  // ---- adding nodes at a point: from the menu, or by dropping a connection on empty canvas ----

  const picker = ref<{ x: number; y: number; at: { x: number; y: number }; target: PickerTarget }>()

  /** Node types that fit where the picker was opened. */
  const pickerTypes = computed(() => {
    const target = picker.value?.target
    const all = [...types.value.values()]
    const hasExecOut = (type: NodeTypeInfo) => portsOf(type, schemaDefaults(type.configSchema)).execOut.length > 0
    if (target?.insert) return all.filter((type) => type.execIn && hasExecOut(type))
    if (target?.connect?.handleType === 'source') return all.filter((type) => type.execIn)
    if (target?.connect?.handleType === 'target') return all.filter(hasExecOut)
    return all
  })

  const pickerTitle = computed(() => {
    const target = picker.value?.target
    if (target?.insert) return t('flows.pickerInsert')
    if (target?.connect) return target.connect.handleType === 'target' ? t('flows.pickerConnectPrev') : t('flows.pickerConnectNext')
    return undefined
  })

  /** Called when the picker opens, so the context menu can close. */
  let onPickerOpen = () => {}
  const whenPickerOpens = (callback: () => void) => (onPickerOpen = callback)

  function openPicker(x: number, y: number, at: { x: number; y: number }, target: PickerTarget) {
    onPickerOpen()
    picker.value = { x, y, at, target }
  }

  function onPick(typeId: string) {
    const current = picker.value
    picker.value = undefined
    const info = types.value.get(typeId)
    if (!current || !info) return
    const { at, target } = current
    const backwards = target.connect?.handleType === 'target'
    // The node's input lands under the pointer; when connecting backwards, its output does.
    const id = addNode(typeId, { x: backwards ? at.x - 250 : at.x, y: at.y - 20 })
    if (!id) return
    const firstOut = execOutHandle(portsOf(info, schemaDefaults(info.configSchema)).execOut[0] ?? 'next')
    const connect = target.connect
    if (connect?.nodeId && connect.handleId) {
      if (backwards) edges.value = [...edges.value, s.link(id, firstOut, connect.nodeId)]
      else edges.value = [...edges.value, s.link(connect.nodeId, connect.handleId, id)]
    }
    if (target.insert) {
      const edge = edges.value.find((item) => item.id === target.insert)
      if (edge) {
        edges.value = [
          ...edges.value.filter((item) => item.id !== edge.id),
          s.link(edge.source, edge.sourceHandle ?? '', id),
          s.link(id, firstOut, edge.target),
        ]
      }
    }
  }

  // Where the pointer last was on the canvas, so pasting with the keyboard lands there.
  let pointer: { x: number; y: number } | undefined
  const trackPointer = (event: PointerEvent) => (pointer = { x: event.clientX, y: event.clientY })

  /** A point on the screen, in canvas coordinates. */
  function toFlow(clientX: number, clientY: number) {
    const rect = canvas.value?.getBoundingClientRect()
    return flow.project({ x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) })
  }
  const pointerFlowPosition = () => (pointer ? toFlow(pointer.x, pointer.y) : undefined)

  function onConnectStart(params: OnConnectStartParams) {
    dragged = params
  }

  /** A connection dropped on empty canvas offers the nodes that can connect there. */
  function onConnectEnd(event?: MouseEvent | TouchEvent) {
    const params = dragged
    dragged = undefined
    if (!params?.nodeId || !event || updatingEdge) return
    const point = 'changedTouches' in event ? event.changedTouches[0] : event
    if (!point) return
    const below = document.elementFromPoint(point.clientX, point.clientY)
    if (!below?.closest('.vue-flow__pane') || below.closest('.vue-flow__node, .flow-group')) return
    const handle = parseHandle(params.handleId)
    if (!handle) return
    openPicker(point.clientX, point.clientY, toFlow(point.clientX, point.clientY), {
      connect: { ...params, handleType: handle.kind === 'exec-out' ? 'source' : 'target' },
    })
  }

  return {
    isValidConnection, onEdgeUpdateStart, onEdgeUpdate, onEdgeUpdateEnd, onConnect, onConnectStart, onConnectEnd,
    addNode, onDrop, onNodeClick, focusNode, updateSelected, deleteSelected,
    picker, pickerTypes, pickerTitle, openPicker, whenPickerOpens, onPick,
    trackPointer, toFlow, pointerFlowPosition,
  }
}
