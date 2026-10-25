<script setup lang="ts">
import { ArrowBackOutline, ConstructOutline, InformationCircleOutline, ListOutline, PlayOutline, TrashOutline } from '@vicons/ionicons5'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { type Connection, type Edge, type GraphNode, type Node, type OnConnectStartParams, useVueFlow, VueFlow } from '@vue-flow/core'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import {
  type DropdownOption, NAlert, NButton, NDropdown, NEmpty, NForm, NFormItem, NIcon, NInput, NSelect, NTabPane, NTabs, NTag, useMessage,
} from 'naive-ui'
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, provide, type Ref, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { call, on } from '../api'
import { type CanvasNodeData, type FlowHighlight, flowEditorKey, type RunStatus } from '../components/flow/context'
import FlowNodeCard from '../components/flow/FlowNodeCard.vue'
import { nodeIcon } from '../components/flow/icons'
import NodePalette from '../components/flow/NodePalette.vue'
import NodePicker from '../components/flow/NodePicker.vue'
import RunLogs, { type TestInput } from '../components/flow/RunLogs.vue'
import VarInput from '../components/flow/VarInput.vue'
import SchemaForm from '../components/SchemaForm.vue'
import { categoryColors, execOutHandle, parseHandle, portColors, portsOf, refOf, refsIn, schemaDefaults, supports, sysPorts } from '../flow'
import { useDataStore } from '../stores/data'
import { useTheme } from '../theme'
import type { FlowDoc, FlowGroupDoc, FlowIssue, NodeTypeInfo, RunStep, RunTrace } from '../types'
import { clone, localize } from '../utils'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const data = useDataStore()
const { isDark } = useTheme()
const flowId = computed(() => String(route.params.id))

const {
  project, fitView, updateNodeInternals, findNode, getSelectedNodes, addSelectedNodes, removeSelectedNodes, viewport,
} = useVueFlow('flow-editor')

const types = ref(new Map<string, NodeTypeInfo>())
// Typed by assertion: Vue's deep ref unwrapping of Vue Flow's node types is too deep for TypeScript.
const nodes = ref([]) as Ref<Node<CanvasNodeData>[]>
const edges = ref([]) as Ref<Edge[]>
/** Nodes framed together; only the editor uses them. */
const groups = ref<FlowGroupDoc[]>([])
const name = ref('')
const description = ref('')
const bots = ref<string[]>([])
/** The adapter saved on the flow; see `currentAdapter` for the one in effect. */
const adapter = ref<string>()
const issues = ref<FlowIssue[]>([])
const runs = ref<RunTrace[]>([])
const loaded = ref(false)
const saving = ref(false)
const savedSignature = ref('')
const selectedId = ref<string>()
const tab = ref<'node' | 'flow'>('flow')
const nodeTab = ref<'settings' | 'io'>('settings')
const highlight = ref<FlowHighlight>({ nodes: new Map(), edges: new Map() })
const canvas = ref<HTMLElement>()
const root = ref<HTMLElement>()
const width = ref(1200)
const showPalette = ref(true)
const showPanel = ref(true)
const showLogs = ref(true)
const logs = ref<InstanceType<typeof RunLogs>>()
const executing = ref<string>()

const issuesByNode = computed(() => {
  const map = new Map<string, FlowIssue[]>()
  for (const issue of issues.value) {
    if (issue.nodeId) map.set(issue.nodeId, [...(map.get(issue.nodeId) ?? []), issue])
  }
  return map
})

const order = computed(() => new Map(nodes.value.map((node, index) => [node.id, index])))
provide(flowEditorKey, { types, issuesByNode, highlight, order, executing, execute: (nodeId: string) => runTest(nodeId), nodeName: (id: string) => nodeName(id) })
const nodeTypes = { mushin: markRaw(FlowNodeCard) } as any

// ---- document <-> canvas ----

function toDoc() {
  return {
    name: name.value,
    description: description.value,
    adapter: adapter.value ?? '',
    bots: bots.value,
    nodes: nodes.value.map((node) => ({
      id: node.id,
      type: node.data!.typeId,
      ...(node.data!.label ? { label: node.data!.label } : {}),
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      config: node.data!.config,
      ...(node.data!.inputs && Object.keys(node.data!.inputs).length ? { inputs: node.data!.inputs } : {}),
    })),
    edges: edges.value.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? '',
      target: edge.target,
      targetHandle: edge.targetHandle ?? '',
    })),
    groups: groups.value,
  }
}

const signature = () => JSON.stringify(toDoc())
const dirty = computed(() => loaded.value && signature() !== savedSignature.value)

const edgeColors: Record<RunStatus, string> = { running: '#2080f0', ok: '#18a058', error: '#d03050' }

/**
 * Every edge means "run next". Grey by default; during a run the edge into a running node is a
 * moving dashed line, then green or red once that node succeeds or fails. Invalid edges are red
 * and dashed. Direction is left to right, so no arrowheads.
 */
function edgeLook(edge: Pick<Edge, 'id'>): Partial<Edge> {
  const status = highlight.value.edges.get(edge.id)
  const broken = issues.value.some((issue) => issue.edgeId === edge.id)
  const color = status ? edgeColors[status] : broken ? '#d03050' : '#8c8c8c'
  return {
    type: 'default',
    animated: status === 'running',
    class: status ? `edge-${status}` : undefined,
    style: { stroke: color, strokeWidth: status ? 2.5 : 2, ...(broken && !status ? { strokeDasharray: '4 4' } : {}) },
  }
}

function restyleEdges() {
  edges.value = edges.value.map((edge) => ({ ...edge, ...edgeLook(edge) }))
}

let savedAt = 0

/** Puts a flow from the server on the canvas; `fit` re-centers the view. */
function apply(flow: FlowDoc, fit: boolean) {
  name.value = flow.name
  description.value = flow.description ?? ''
  bots.value = [...flow.bots]
  adapter.value = flow.adapter
  issues.value = flow.issues
  nodes.value = flow.nodes.map((node) => ({
    id: node.id,
    type: 'mushin',
    position: { ...node.position },
    data: { typeId: node.type, label: node.label, config: node.config ?? {}, inputs: { ...node.inputs } },
  }))
  edges.value = flow.edges.map((edge) => ({ ...edge, ...edgeLook(edge) }))
  groups.value = clone(flow.groups ?? [])
  if (selectedId.value && !flow.nodes.some((node) => node.id === selectedId.value)) selectedId.value = undefined
  savedAt = flow.updatedAt
  savedSignature.value = signature()
  loaded.value = true
  if (fit) pendingFit = true
}

let pendingFit = false
function onNodesInitialized() {
  if (!pendingFit) return
  pendingFit = false
  fitView({ padding: 0.2, maxZoom: 1.2 })
}

async function load() {
  loaded.value = false
  const [typeList, flow, recent] = await Promise.all([
    call<NodeTypeInfo[]>('flows.nodeTypes'),
    call<FlowDoc>('flows.get', { id: flowId.value }),
    call<RunTrace[]>('flows.runs', { id: flowId.value }),
  ])
  types.value = new Map(typeList.map((type) => [type.type, type]))
  runs.value = [...recent].reverse()
  apply(flow, true)
}

// Someone else (usually the Agent) changed the flow: follow along unless there are local edits.
const offChanged = on('flows/changed', async () => {
  if (!loaded.value || dirty.value || saving.value) return
  try {
    const flow = await call<FlowDoc>('flows.get', { id: flowId.value })
    if (flow.updatedAt !== savedAt && !dirty.value) apply(flow, false)
  } catch {}
})
onBeforeUnmount(offChanged)

onMounted(() => {
  load().catch((error) => message.error(error.message))
  if (!data.loadedBots) data.refreshBots().catch(() => {})
})
watch(flowId, () => load().catch((error) => message.error(error.message)))

// ---- editing ----

function isValidConnection(connection: Connection) {
  if (connection.source === connection.target) return false
  return parseHandle(connection.sourceHandle)?.kind === 'exec-out' && parseHandle(connection.targetHandle)?.kind === 'exec-in'
}

function onConnect(connection: Connection) {
  dragged = undefined
  if (!isValidConnection(connection)) return
  const kept = edges.value
  if (kept.some((edge) => edge.source === connection.source && edge.sourceHandle === connection.sourceHandle
    && edge.target === connection.target && edge.targetHandle === connection.targetHandle)) return
  const edge = {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    source: connection.source,
    sourceHandle: connection.sourceHandle ?? '',
    target: connection.target,
    targetHandle: connection.targetHandle ?? '',
  }
  edges.value = [...kept, { ...edge, ...edgeLook(edge) }]
}

function nextNodeId() {
  const used = new Set(nodes.value.map((node) => node.id))
  let index = nodes.value.length + 1
  while (used.has(`n${index}`)) index++
  return `n${index}`
}

function addNode(typeId: string, position?: { x: number; y: number }) {
  const info = types.value.get(typeId)
  if (!info || !supports(info, currentAdapter.value)) return
  let at = position
  if (!at) {
    const rect = canvas.value?.getBoundingClientRect()
    const jitter = (nodes.value.length % 5) * 24
    at = project({ x: (rect?.width ?? 800) / 2 - 110 + jitter, y: (rect?.height ?? 600) / 2 - 60 + jitter })
  }
  const id = nextNodeId()
  nodes.value = [...nodes.value, { id, type: 'mushin', position: at, data: { typeId, config: schemaDefaults(info.configSchema) } }]
  selectedId.value = id
  tab.value = 'node'
  showPanel.value = true
  if (narrow.value) showPalette.value = false
  return id
}

function onDrop(event: DragEvent) {
  const typeId = event.dataTransfer?.getData('application/mushin-node')
  const rect = canvas.value?.getBoundingClientRect()
  if (!typeId || !rect) return
  addNode(typeId, project({ x: event.clientX - rect.left - 110, y: event.clientY - rect.top - 20 }))
}

const selected = computed(() => nodes.value.find((node) => node.id === selectedId.value))
const selectedInfo = computed(() => selected.value && types.value.get(selected.value.data!.typeId))

function onNodeClick({ node }: { node: Node }) {
  selectedId.value = node.id
  tab.value = 'node'
  logs.value?.showNode(node.id)
  if (narrow.value) {
    showPanel.value = true
    showPalette.value = false
  }
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
  updateNodeInternals([node.id])
}

function deleteSelected() {
  const id = selectedId.value
  if (!id) return
  nodes.value = nodes.value.filter((node) => node.id !== id)
  edges.value = edges.value.filter((edge) => edge.source !== id && edge.target !== id)
  selectedId.value = undefined
  tab.value = 'flow'
}

function selectIssue(issue: FlowIssue) {
  if (!issue.nodeId) return
  selectedId.value = issue.nodeId
  tab.value = 'node'
}

// ---- saving ----

async function save() {
  if (saving.value) return
  saving.value = true
  try {
    const result = await call<FlowDoc>('flows.update', { id: flowId.value, ...toDoc(), adapter: currentAdapter.value ?? '' })
    adapter.value = result.adapter
    issues.value = result.issues
    restyleEdges()
    savedAt = result.updatedAt
    savedSignature.value = signature()
    const errors = result.issues.filter((issue) => issue.severity === 'error').length
    if (errors) message.warning(t('flows.savedWithErrors', errors))
    else message.success(t('common.saved'))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') menu.value = undefined
  if (!(event.ctrlKey || event.metaKey)) return
  const key = event.key.toLowerCase()
  if (key === 's') {
    event.preventDefault()
    save()
    return
  }
  // Canvas shortcuts leave text fields alone.
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, [contenteditable="true"]')) return
  const ids = selectionIds()
  if (key === 'c' && ids.length) copyNodes(ids)
  else if (key === 'v' && clipboard) pasteNodes(pointerFlowPosition())
  else if (key === 'd' && ids.length) duplicateNodes(ids)
  else if (key === 'g' && event.shiftKey && ids.length) ungroupNodes(ids)
  else if (key === 'g' && !event.shiftKey && ids.length > 1) groupNodes(ids)
  else if (key === 'a') selectAll()
  else return
  event.preventDefault()
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) event.preventDefault()
}

const observer = new ResizeObserver(([entry]) => (width.value = entry.contentRect.width))
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', onBeforeUnload)
  if (root.value) {
    width.value = root.value.clientWidth
    observer.observe(root.value)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('beforeunload', onBeforeUnload)
  observer.disconnect()
})
onBeforeRouteLeave(() => !dirty.value || window.confirm(t('flows.unsaved')))

// ---- groups, clipboard, context menu ----

/** Selected node ids: the canvas selection, or the node open in the panel. */
function selectionIds() {
  const ids = getSelectedNodes.value.map((node) => node.id)
  return ids.length ? ids : selectedId.value ? [selectedId.value] : []
}

function select(ids: string[]) {
  removeSelectedNodes(getSelectedNodes.value)
  addSelectedNodes(ids.map((id) => findNode(id)).filter((node): node is GraphNode => !!node))
}

const selectAll = () => select(nodes.value.map((node) => node.id))

// A group needs two nodes that still exist; deleting nodes shrinks or removes their groups.
watch(() => nodes.value.map((node) => node.id).join(','), () => {
  const known = new Set(nodes.value.map((node) => node.id))
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

function deleteNodes(ids: string[]) {
  const gone = new Set(ids)
  nodes.value = nodes.value.filter((node) => !gone.has(node.id))
  edges.value = edges.value.filter((edge) => !gone.has(edge.source) && !gone.has(edge.target))
  if (selectedId.value && gone.has(selectedId.value)) {
    selectedId.value = undefined
    tab.value = 'flow'
  }
}

const GROUP_PAD = 18
const GROUP_HEAD = 28

/** Dashed frames around grouped nodes, in canvas coordinates. */
const frames = computed(() => groups.value.flatMap((group) => {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const id of group.nodes) {
    const node = nodes.value.find((item) => item.id === id)
    if (!node) continue
    const size = findNode(id)?.dimensions
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

/** Dragging a frame's header moves its nodes; a click selects them. */
function startGroupDrag(event: PointerEvent, group: FlowGroupDoc) {
  if (event.button !== 0 || renaming.value === group.id) return
  const start = { x: event.clientX, y: event.clientY }
  const origin = new Map(nodes.value.filter((node) => group.nodes.includes(node.id)).map((node) => [node.id, { ...node.position }]))
  select(group.nodes)
  const move = (moved: PointerEvent) => {
    const zoom = viewport.value.zoom || 1
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

const renaming = ref<string>()
function renameGroup(id: string, label: string) {
  groups.value = groups.value.map((group) => (group.id === id ? { ...group, label: label.trim() || undefined } : group))
  renaming.value = undefined
}

interface Clipboard {
  nodes: { id: string; type: string; label?: string; position: { x: number; y: number }; config: Record<string, any>; inputs?: Record<string, string> }[]
  edges: { source: string; sourceHandle: string; target: string; targetHandle: string }[]
  groups: { label?: string; nodes: string[] }[]
}

const CLIPBOARD_KEY = 'mushin.flows.clipboard'
// Kept in this browser so nodes can be pasted into another flow.
let clipboard: Clipboard | undefined = (() => {
  try {
    return JSON.parse(localStorage.getItem(CLIPBOARD_KEY) ?? 'null') ?? undefined
  } catch {
    return undefined
  }
})()

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
    edges: edges.value.filter((edge) => set.has(edge.source) && set.has(edge.target)).map((edge) => ({
      source: edge.source, sourceHandle: edge.sourceHandle ?? '', target: edge.target, targetHandle: edge.targetHandle ?? '',
    })),
    groups: groups.value.filter((group) => group.nodes.every((id) => set.has(id))).map((group) => ({ label: group.label, nodes: group.nodes })),
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
  const links = copy.edges.map((edge) => {
    const item = { ...edge, id: `e-${Math.random().toString(36).slice(2, 8)}`, source: ids.get(edge.source)!, target: ids.get(edge.target)! }
    return { ...item, ...edgeLook(item) }
  })
  nodes.value = [...nodes.value, ...added]
  edges.value = [...edges.value, ...links]
  groups.value = [...groups.value, ...copy.groups.map((group) => ({
    id: `g-${Math.random().toString(36).slice(2, 7)}`, label: group.label, nodes: group.nodes.map((id) => ids.get(id)!),
  }))]
  nextTick(() => select(added.map((node) => node.id)))
}

const pasteNodes = (at?: { x: number; y: number }) => clipboard && insertCopy(clipboard, at)
const duplicateNodes = (ids: string[]) => insertCopy(snapshot(ids))

// Where the pointer last was on the canvas, so pasting with the keyboard lands there.
let pointer: { x: number; y: number } | undefined
function toFlow(clientX: number, clientY: number) {
  const rect = canvas.value?.getBoundingClientRect()
  return project({ x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) })
}
const pointerFlowPosition = () => (pointer ? toFlow(pointer.x, pointer.y) : undefined)

type MenuKind = 'pane' | 'node' | 'selection' | 'group' | 'edge'
const menu = ref<{ x: number; y: number; kind: MenuKind; target?: string; ids: string[]; at: { x: number; y: number } }>()

function openMenu(event: MouseEvent | TouchEvent, kind: MenuKind, target?: string, ids: string[] = []) {
  event.preventDefault()
  const point = 'touches' in event ? event.touches[0] ?? event.changedTouches[0] : event
  picker.value = undefined
  menuOpenedAt = Date.now()
  menu.value = { x: point.clientX, y: point.clientY, kind, target, ids, at: toFlow(point.clientX, point.clientY) }
}

// The right button's own mouseup can land outside the menu it just opened; that is not a click away.
let menuOpenedAt = 0
function onMenuClickOutside() {
  if (Date.now() - menuOpenedAt > 250) menu.value = undefined
}

function onNodeContextMenu({ event, node }: { event: MouseEvent | TouchEvent; node: GraphNode }) {
  const selection = getSelectedNodes.value.map((item) => item.id)
  if (selection.length > 1 && selection.includes(node.id)) openMenu(event, 'selection', undefined, selection)
  else {
    select([node.id])
    selectedId.value = node.id
    openMenu(event, 'node', node.id, [node.id])
  }
}

const inGroup = (ids: string[]) => groups.value.some((group) => group.nodes.some((id) => ids.includes(id)))

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
      { key: 'deleteEdge', label: t('flows.menuDeleteEdge') },
    ]
  }
  if (kind === 'group') {
    return [
      { key: 'rename', label: t('flows.menuRenameGroup') },
      { key: 'copy', label: t('flows.menuCopy') },
      { key: 'duplicate', label: t('flows.menuDuplicate') },
      divider('d1'),
      { key: 'ungroup', label: t('flows.menuUngroup') },
      { key: 'delete', label: t('flows.menuDeleteGroup') },
    ]
  }
  return [
    ...(kind === 'node' ? [{ key: 'execute', label: t('flows.executeStep'), disabled: testing.value }] : []),
    ...(kind === 'selection' ? [{ key: 'group', label: t('flows.menuGroup') }] : []),
    ...(inGroup(ids) ? [{ key: 'ungroup', label: t('flows.menuUngroup') }] : []),
    divider('d1'),
    { key: 'copy', label: t('flows.menuCopy') },
    { key: 'duplicate', label: t('flows.menuDuplicate') },
    divider('d2'),
    { key: 'delete', label: t('flows.menuDelete') },
  ]
})

function onMenuSelect(key: string) {
  const current = menu.value
  menu.value = undefined
  if (!current) return
  const { ids, target, at } = current
  switch (key) {
    case 'add': return openPicker(current.x, current.y, at, {})
    case 'paste': return pasteNodes(at)
    case 'selectAll': return selectAll()
    case 'fit': return fitView({ padding: 0.2, maxZoom: 1.2 })
    case 'execute': return target && runTest(target)
    case 'group': return groupNodes(ids)
    case 'ungroup': return current.kind === 'group' ? (groups.value = groups.value.filter((group) => group.id !== target)) : ungroupNodes(ids)
    case 'rename': return (renaming.value = target)
    case 'copy': return copyNodes(ids)
    case 'duplicate': return duplicateNodes(ids)
    case 'delete': return deleteNodes(ids)
    case 'deleteEdge': return (edges.value = edges.value.filter((edge) => edge.id !== target))
    case 'insert': return openPicker(current.x, current.y, at, { insert: target })
  }
}

// ---- adding nodes at a point: from the menu, or by dropping a connection on empty canvas ----

interface PickerTarget {
  /** Connect from (source) or to (target) this handle. */
  connect?: OnConnectStartParams
  /** Put the node in the middle of this edge. */
  insert?: string
}
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

function openPicker(x: number, y: number, at: { x: number; y: number }, target: PickerTarget) {
  menu.value = undefined
  picker.value = { x, y, at, target }
}

function link(source: string, sourceHandle: string, target: string) {
  const edge = { id: `e-${Math.random().toString(36).slice(2, 8)}`, source, sourceHandle, target, targetHandle: 'exec' }
  return { ...edge, ...edgeLook(edge) }
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
    if (backwards) edges.value = [...edges.value, link(id, firstOut, connect.nodeId)]
    else edges.value = [...edges.value, link(connect.nodeId, connect.handleId, id)]
  }
  if (target.insert) {
    const edge = edges.value.find((item) => item.id === target.insert)
    if (edge) {
      edges.value = [
        ...edges.value.filter((item) => item.id !== edge.id),
        link(edge.source, edge.sourceHandle ?? '', id),
        link(id, firstOut, edge.target),
      ]
    }
  }
}

let dragged: OnConnectStartParams | undefined
function onConnectStart(params: OnConnectStartParams) {
  dragged = params
}

/** A connection dropped on empty canvas offers the nodes that can connect there. */
function onConnectEnd(event?: MouseEvent | TouchEvent) {
  const params = dragged
  dragged = undefined
  if (!params?.nodeId || !event) return
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

// ---- runs and tests ----

let clearTimer: number | undefined
/** The run being drawn live from its steps, until its trace arrives. */
let liveRun: string | undefined

function clearHighlight() {
  window.clearTimeout(clearTimer)
  liveRun = undefined
  highlight.value = { nodes: new Map(), edges: new Map() }
  restyleEdges()
}

/** Draws a finished run: each edge takes the state of the node it led to. */
function showTrace(trace: RunTrace) {
  const nodeStatus = new Map<string, RunStatus>(trace.steps.map((step) => [step.nodeId, step.error ? 'error' : 'ok']))
  const target = new Map(edges.value.map((edge) => [edge.id, edge.target]))
  const edgeStatus = new Map<string, RunStatus>(trace.edges.map((id) => {
    const status = nodeStatus.get(target.get(id) ?? '')
    return [id, status ?? (trace.error ? 'error' : 'ok')]
  }))
  liveRun = undefined
  highlight.value = { nodes: nodeStatus, edges: edgeStatus }
  restyleEdges()
  window.clearTimeout(clearTimer)
  clearTimer = window.setTimeout(clearHighlight, 10_000)
}

/** A node of a run in this flow started or finished: update the canvas while the run goes on. */
function showStep(step: RunStep) {
  window.clearTimeout(clearTimer)
  if (liveRun !== step.runId) {
    liveRun = step.runId
    highlight.value = { nodes: new Map(), edges: new Map() }
  }
  const next: FlowHighlight = { nodes: new Map(highlight.value.nodes), edges: new Map(highlight.value.edges) }
  next.nodes.set(step.nodeId, step.status)
  if (step.edgeId) next.edges.set(step.edgeId, step.status)
  highlight.value = next
  restyleEdges()
}

const off = on('flows/run', (trace: RunTrace) => {
  if (trace.flowId !== flowId.value) return
  runs.value = [trace, ...runs.value].slice(0, 20)
  if (!trace.test || liveRun === trace.id) showTrace(trace)
})
onBeforeUnmount(off)
const offStep = on('flows/step', (step: RunStep) => {
  if (step.flowId === flowId.value) showStep(step)
})
onBeforeUnmount(offStep)

const test = ref<TestInput>({
  text: '', userName: '', private: false, mentioned: false, mode: 'message', eventName: '', eventData: '{}', schedule: '', replies: '',
})
const testing = ref(false)
const schedules = computed(() => nodes.value
  .filter((node) => node.data?.typeId === 'trigger.schedule')
  .map((node) => ({ id: node.id, name: nodeName(node.id) })))

/** The flows.test input for the current test settings, or undefined when something is missing. */
function testPayload() {
  const { mode, text, userName, mentioned, eventName, eventData, schedule, replies } = test.value
  const answers = replies.split('\n').map((line) => line.trim()).filter(Boolean)
  const common = answers.length ? { replies: answers } : {}
  if (mode === 'event') {
    if (!eventName.trim()) return
    let data: unknown
    try {
      data = JSON.parse(eventData || '{}')
    } catch {
      data = undefined
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(t('flows.testEventInvalid'))
    return { event: { name: eventName.trim(), data }, userName, ...common }
  }
  if (mode === 'schedule') return schedule ? { schedule, ...common } : undefined
  if (!text.trim()) return
  return { text, userName, private: test.value.private, mentioned, ...common }
}

/** Runs the saved flow with the test message; with a node, only the path up to that node runs. */
async function runTest(nodeId?: string) {
  if (testing.value) return
  let payload: ReturnType<typeof testPayload>
  try {
    payload = testPayload()
  } catch (error) {
    message.error((error as Error).message)
    return
  }
  if (!payload) {
    message.info(t('flows.testNeedsMessage'))
    showLogs.value = true
    await nextTick()
    logs.value?.focusInput()
    return
  }
  testing.value = true
  executing.value = nodeId
  try {
    // Tests run the saved flow, so save pending edits first.
    if (dirty.value) await save()
    const result = await call<{ matched: boolean; trace: RunTrace }>('flows.test', { id: flowId.value, ...payload, nodeId })
    if (!runs.value.some((run) => run.id === result.trace.id)) runs.value = [result.trace, ...runs.value].slice(0, 20)
    showTrace(result.trace)
    await nextTick()
    logs.value?.focus(result.trace.id)
    if (!result.matched) message.info(t('flows.testNoMatch'))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    testing.value = false
    executing.value = undefined
  }
}

function clearRuns() {
  runs.value = []
  clearHighlight()
}

function selectFromLogs(nodeId: string) {
  if (!nodes.value.some((node) => node.id === nodeId)) return
  selectedId.value = nodeId
  tab.value = 'node'
}

/** The flow's adapter: the saved one, or the only adapter there is. */
const currentAdapter = computed(() => adapter.value || (data.adapters.length === 1 ? data.adapters[0].id : undefined))
const adapterName = (id: string) => localize(data.adapters.find((item) => item.id === id)?.displayName, locale.value) || id
const adapterOptions = computed(() => data.adapters.map((item) => ({ label: localize(item.displayName, locale.value) || item.id, value: item.id })))
function setAdapter(value: string | null) {
  adapter.value = value ?? undefined
  // Bots on another adapter cannot run this flow's adapter-specific nodes.
  if (value) bots.value = bots.value.filter((id) => data.bots.find((bot) => bot.id === id)?.adapter.type === value)
}
// Bots of other adapters are left out; ones already picked stay so they can be removed.
const botOptions = computed(() => data.bots
  .filter((bot) => !currentAdapter.value || bot.adapter.type === currentAdapter.value || bots.value.includes(bot.id))
  .map((bot) => ({ label: bot.name, value: bot.id })))
const errorCount = computed(() => issues.value.filter((issue) => issue.severity === 'error').length)
const warningCount = computed(() => issues.value.length - errorCount.value)
const typeTitle = (typeId: string) => localize(types.value.get(typeId)?.title, locale.value) || typeId
const nodeName = (id: string) => {
  const node = nodes.value.find((item) => item.id === id)
  return node ? node.data!.label || typeTitle(node.data!.typeId) : id
}
const minimapColor = (node: Node<CanvasNodeData>) => {
  const info = types.value.get(node.data?.typeId ?? '')
  return info ? categoryColors[info.category] : '#8c8c8c'
}
const nodeType = (id: string) => nodes.value.find((item) => item.id === id)?.data!.typeId
const selectedNumber = computed(() => String((order.value.get(selectedId.value ?? '') ?? 0) + 1).padStart(2, '0'))
const selectedColor = computed(() => (selectedInfo.value ? categoryColors[selectedInfo.value.category] : '#8c8c8c'))
const selectedIcon = computed(() => selected.value && nodeIcon(selected.value.data!.typeId, selectedInfo.value?.category))

/** Where the selected node's values come from and go, for the inputs / outputs tab. */
const wiring = computed(() => {
  const node = selected.value
  const info = selectedInfo.value
  if (!node || !info) return undefined
  const ports = portsOf(info, node.data!.config)
  const readers = (port: string) => nodes.value
    .filter((item) => refsIn(JSON.stringify([item.data!.config, item.data!.inputs ?? {}])).some((ref) => ref.head === node.id && ref.name === port))
    .map((item) => nodeName(item.id))
  return {
    inputs: ports.inputs.map((port) => ({ port, binding: node.data!.inputs?.[port.name] ?? '' })),
    outputs: ports.outputs.map((port) => ({ port, ref: refOf(node.id, port.name), readers: readers(port.name) })),
    exec: ports.execOut.map((name) => ({
      name,
      to: edges.value.filter((item) => item.source === node.id && item.sourceHandle === `exec:${name}`).map((item) => nodeName(item.target)),
    })),
  }
})

/** Variables the selected node can read: outputs of nodes that run before it, then the message. */
const varGroups = computed(() => {
  const id = selectedId.value
  if (!id) return []
  const before: string[] = []
  const queue = [id]
  const seen = new Set(queue)
  while (queue.length) {
    const current = queue.shift()!
    for (const edge of edges.value.filter((item) => item.target === current)) {
      if (seen.has(edge.source)) continue
      seen.add(edge.source)
      before.push(edge.source)
      queue.push(edge.source)
    }
  }
  const groups = before.flatMap((source) => {
    const info = types.value.get(nodeType(source) ?? '')
    if (!info?.outputs.length) return []
    return [{
      key: source,
      label: nodeName(source),
      items: info.outputs.map((port) => ({ ref: refOf(source, port.name), label: portLabel(port), type: port.type })),
    }]
  })
  return [
    ...groups,
    { key: 'sys', label: t('flows.varsMessage'), items: sysPorts.map((port) => ({ ref: refOf('sys', port.name), label: portLabel(port), type: port.type })) },
  ]
})

// Literal braces cannot go in i18n messages or template expressions, so the examples are passed in.
const refExamples = { node: refOf('n1', 'text'), sys: refOf('sys', 'user'), chat: refOf('chat', 'name') }

function setInput(port: string, value: string) {
  const inputs = { ...selected.value?.data!.inputs }
  if (value) inputs[port] = value
  else delete inputs[port]
  updateSelected({ inputs })
}

const lastStep = computed(() => {
  for (const run of runs.value) {
    const step = run.steps.find((item) => item.nodeId === selectedId.value)
    if (step) return { run, step }
  }
  return undefined
})
const portLabel = (port: { name: string; title?: any }) => localize(port.title, locale.value) || port.name
// Below this width the palette and panel float over the canvas instead of squeezing it.
const narrow = computed(() => width.value < 1000)
watch(narrow, (value) => {
  showPalette.value = !value
  showPanel.value = !value
  showLogs.value = !value
}, { immediate: true })
</script>

<template>
  <div ref="root" class="editor" :class="{ dark: isDark, narrow }" :style="{ '--flow-node-bg': isDark ? '#26262c' : '#fff', '--flow-node-fg': isDark ? '#e6e6e6' : '#222', '--flow-accent-strength': isDark ? '62%' : '100%' }">
    <header class="editor-head">
      <NButton quaternary circle :aria-label="t('common.back')" @click="router.push('/flows')">
        <template #icon><NIcon><ArrowBackOutline /></NIcon></template>
      </NButton>
      <NInput v-model:value="name" class="name-input" :placeholder="t('common.name')" />
      <NSelect
        :value="currentAdapter ?? null"
        class="adapter-select"
        :options="adapterOptions"
        :placeholder="t('flows.adapterAny')"
        :clearable="adapterOptions.length > 1"
        :title="t('flows.adapter')"
        data-agent-target="flows.adapter"
        @update:value="setAdapter"
      />
      <NSelect
        v-model:value="bots"
        class="bots-select"
        multiple
        :options="botOptions"
        :placeholder="t('flows.runsOnNone')"
        max-tag-count="responsive"
        data-agent-target="flows.bots"
      />
      <NTag v-if="errorCount" type="error" size="small" :bordered="false">{{ t('flows.errorCount', errorCount) }}</NTag>
      <NTag v-else-if="warningCount" type="warning" size="small" :bordered="false">{{ t('flows.warningCount', warningCount) }}</NTag>
      <span class="spacer" />
      <span class="save-state">{{ dirty ? t('flows.unsavedShort') : t('flows.savedShort') }}</span>
      <NButton v-if="narrow" quaternary circle :aria-label="t('flows.palette')" @click="showPalette = !showPalette; showPanel = false">
        <template #icon><NIcon><ListOutline /></NIcon></template>
      </NButton>
      <NButton v-if="narrow" quaternary circle :aria-label="t('flows.panel')" @click="showPanel = !showPanel; showPalette = false">
        <template #icon><NIcon><ConstructOutline /></NIcon></template>
      </NButton>
      <NButton type="primary" :loading="saving" :disabled="!dirty" data-agent-target="flows.save" @click="save">{{ t('common.save') }}</NButton>
    </header>

    <div class="editor-body">
      <NodePalette
        v-if="showPalette"
        class="side"
        :types="[...types.values()]"
        :adapter="currentAdapter"
        :adapter-name="adapterName"
        @add="(typeId: string) => addNode(typeId)"
      />

      <div class="main">
        <div ref="canvas" class="canvas" @dragover.prevent @drop.prevent="onDrop" @pointermove="pointer = { x: $event.clientX, y: $event.clientY }">
          <VueFlow
            id="flow-editor"
            v-model:nodes="nodes"
            v-model:edges="edges"
            :node-types="nodeTypes"
            :is-valid-connection="isValidConnection"
            :delete-key-code="['Delete', 'Backspace']"
            :min-zoom="0.2"
            :max-zoom="2"
            :default-edge-options="{ type: 'default' }"
            @connect="onConnect"
            @connect-start="onConnectStart"
            @connect-end="onConnectEnd"
            @nodes-initialized="onNodesInitialized"
            @node-click="onNodeClick"
            @pane-click="selectedId = undefined"
            @pane-context-menu="openMenu($event, 'pane')"
            @node-context-menu="onNodeContextMenu"
            @selection-context-menu="({ event, nodes: picked }) => openMenu(event, 'selection', undefined, picked.map((node) => node.id))"
            @edge-context-menu="({ event, edge }) => openMenu(event, 'edge', edge.id)"
          >
            <template #zoom-pane>
              <div
                v-for="frame in frames"
                :key="frame.group.id"
                class="flow-group"
                :style="frame.style"
              >
                <div
                  class="flow-group-head"
                  :title="t('flows.groupHint')"
                  @pointerdown.stop="startGroupDrag($event, frame.group)"
                  @dblclick.stop="renaming = frame.group.id"
                  @contextmenu.stop="openMenu($event, 'group', frame.group.id, frame.group.nodes)"
                >
                  <input
                    v-if="renaming === frame.group.id"
                    class="flow-group-rename nodrag"
                    :value="frame.group.label ?? ''"
                    :placeholder="t('flows.groupDefault')"
                    autofocus
                    @pointerdown.stop
                    @keydown.enter="renameGroup(frame.group.id, ($event.target as HTMLInputElement).value)"
                    @keydown.esc="renaming = undefined"
                    @blur="renameGroup(frame.group.id, ($event.target as HTMLInputElement).value)"
                  >
                  <span v-else class="flow-group-label">{{ frame.group.label || t('flows.groupDefault') }}</span>
                  <span class="flow-group-count">{{ frame.group.nodes.length }}</span>
                </div>
              </div>
            </template>
            <Background :gap="20" :pattern-color="isDark ? '#3a3a40' : '#d9d9d9'" />
            <Controls />
            <MiniMap v-if="!narrow" pannable zoomable :node-color="minimapColor" :mask-color="isDark ? 'rgba(20, 20, 24, 0.7)' : undefined" />
          </VueFlow>
          <div v-if="loaded && !nodes.length" class="canvas-empty">{{ t('flows.emptyCanvas') }}</div>
          <NDropdown
            trigger="manual"
            placement="bottom-start"
            size="small"
            :show="!!menu"
            :x="menu?.x ?? 0"
            :y="menu?.y ?? 0"
            :options="menuOptions"
            @select="onMenuSelect"
            @clickoutside="onMenuClickOutside"
          />
          <NodePicker
            v-if="picker"
            :key="`${picker.x},${picker.y}`"
            :types="pickerTypes"
            :x="picker.x"
            :y="picker.y"
            :title="pickerTitle"
            :adapter="currentAdapter"
            :adapter-name="adapterName"
            @pick="onPick"
            @close="picker = undefined"
          />
        </div>
        <RunLogs
          ref="logs"
          v-model:test="test"
          v-model:open="showLogs"
          :runs="runs"
          :schedules="schedules"
          :testing="testing"
          :node-name="nodeName"
          :node-type="nodeType"
          @run="runTest()"
          @clear="clearRuns"
          @show="showTrace"
          @select="selectFromLogs"
        />
      </div>

      <aside v-if="showPanel" class="panel side">
        <NTabs v-model:value="tab" type="line" size="small" justify-content="space-evenly" class="panel-tabs">
          <NTabPane name="node" :tab="t('flows.tabNode')">
            <template v-if="selected && selectedInfo">
              <div class="node-head" :style="{ '--accent': selectedColor }">
                <span class="node-icon"><NIcon :size="20"><component :is="selectedIcon" /></NIcon></span>
                <div class="node-title">
                  <div class="node-name"><span class="node-number">{{ selectedNumber }}</span>{{ selected.data!.label || typeTitle(selected.data!.typeId) }}</div>
                  <div class="muted small">{{ selected.data!.label ? typeTitle(selected.data!.typeId) : selected.data!.typeId }}</div>
                </div>
                <NButton quaternary circle size="small" type="error" :title="t('flows.deleteNode')" :aria-label="t('flows.deleteNode')" @click="deleteSelected">
                  <template #icon><NIcon><TrashOutline /></NIcon></template>
                </NButton>
              </div>

              <NTabs v-model:value="nodeTab" type="segment" size="small" class="node-tabs">
                <NTabPane name="settings" :tab="t('flows.nodeSettings')">
                  <NForm label-placement="top" size="small">
                    <NFormItem :label="t('flows.nodeLabel')" :feedback="t('flows.nodeLabelHint')">
                      <NInput :value="selected.data!.label ?? ''" :placeholder="typeTitle(selected.data!.typeId)" @update:value="(label: string) => updateSelected({ label: label || undefined })" />
                    </NFormItem>
                  </NForm>
                  <template v-if="wiring?.inputs.length">
                    <div class="inputs-title">{{ t('flows.ioInputs') }}</div>
                    <NForm label-placement="top" size="small">
                      <NFormItem v-for="item in wiring.inputs" :key="item.port.name">
                        <template #label>
                          {{ portLabel(item.port) }}
                          <span class="port-type" :style="{ color: portColors[item.port.type] }">{{ item.port.type }}</span>
                        </template>
                        <VarInput :model-value="item.binding" :groups="varGroups" @update:model-value="(value: string) => setInput(item.port.name, value)" />
                      </NFormItem>
                    </NForm>
                    <p class="muted small vars-hint">{{ t('flows.varsHint', refExamples) }}</p>
                  </template>
                  <SchemaForm
                    v-if="selectedInfo.configSchema"
                    :model-value="selected.data!.config"
                    :schema="selectedInfo.configSchema"
                    @update:model-value="(config: Record<string, any>) => updateSelected({ config: clone(config) })"
                  />
                  <NAlert v-for="(issue, index) in issuesByNode.get(selected.id) ?? []" :key="index" :type="issue.severity" :show-icon="false" class="issue">
                    {{ issue.message }}
                  </NAlert>
                </NTabPane>

                <NTabPane name="io" :tab="t('flows.nodeIO')">
                  <template v-if="wiring">
                    <h4 class="section">{{ t('flows.ioInputs') }}</h4>
                    <p v-if="!wiring.inputs.length" class="muted small">{{ t('flows.ioNone') }}</p>
                    <div v-for="item in wiring.inputs" :key="item.port.name" class="io-row">
                      <span class="io-dot" :style="{ background: portColors[item.port.type] }" />
                      <span class="io-name">{{ portLabel(item.port) }}</span>
                      <code v-if="item.binding" class="io-link">{{ item.binding }}</code>
                      <span v-else class="io-link muted">{{ t('flows.ioUnset') }}</span>
                    </div>
                    <h4 class="section">{{ t('flows.ioBranches') }}</h4>
                    <p v-if="!wiring.exec.length" class="muted small">{{ t('flows.ioNone') }}</p>
                    <div v-for="item in wiring.exec" :key="`exec-${item.name}`" class="io-row">
                      <span class="io-arrow" />
                      <span class="io-name">{{ item.name }}</span>
                      <span class="io-link" :class="{ muted: !item.to.length }">{{ item.to.join(', ') || t('flows.ioUnlinked') }}</span>
                    </div>
                    <h4 class="section">{{ t('flows.ioOutputs') }}</h4>
                    <p v-if="!wiring.outputs.length" class="muted small">{{ t('flows.ioNone') }}</p>
                    <div v-for="item in wiring.outputs" :key="item.port.name" class="io-row">
                      <span class="io-dot" :style="{ background: portColors[item.port.type] }" />
                      <span class="io-name">{{ portLabel(item.port) }}</span>
                      <code class="io-ref">{{ item.ref }}</code>
                      <span class="io-link" :class="{ muted: !item.readers.length }">{{ item.readers.join(', ') || t('flows.ioUnread') }}</span>
                    </div>
                    <h4 class="section">{{ t('flows.ioLastRun') }}</h4>
                    <p v-if="!lastStep" class="muted small">{{ t('flows.ioNotRun') }}</p>
                    <template v-else>
                      <div v-if="lastStep.step.error" class="step-error">{{ lastStep.step.error }}</div>
                      <div class="muted small">{{ t('flows.logsInput') }}</div>
                      <pre class="json">{{ lastStep.step.inputs && Object.keys(lastStep.step.inputs).length ? JSON.stringify(lastStep.step.inputs, null, 2) : '—' }}</pre>
                      <div class="muted small">{{ t('flows.logsOutput') }}</div>
                      <pre class="json">{{ lastStep.step.outputs && Object.keys(lastStep.step.outputs).length ? JSON.stringify(lastStep.step.outputs, null, 2) : '—' }}</pre>
                    </template>
                  </template>
                </NTabPane>
              </NTabs>

              <div class="node-foot">
                <div v-if="selectedInfo.description" class="node-note">
                  <NIcon :size="14" class="note-icon"><InformationCircleOutline /></NIcon>
                  <span>{{ localize(selectedInfo.description, locale) }}</span>
                </div>
                <NButton type="primary" block :loading="executing === selected.id" :disabled="testing" @click="runTest(selected.id)">
                  <template #icon><NIcon><PlayOutline /></NIcon></template>
                  {{ t('flows.executeStep') }}
                </NButton>
              </div>
            </template>
            <NEmpty v-else :description="t('flows.selectNode')" class="panel-empty" />
          </NTabPane>

          <NTabPane name="flow" :tab="t('flows.tabFlow')">
            <NForm label-placement="top" size="small">
              <NFormItem :label="t('flows.description')">
                <NInput v-model:value="description" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" />
              </NFormItem>
            </NForm>
            <h4 class="section">{{ t('flows.issues') }}</h4>
            <p v-if="!issues.length" class="muted">{{ t('flows.noIssues') }}</p>
            <NAlert
              v-for="(issue, index) in issues"
              :key="index"
              :type="issue.severity"
              :show-icon="false"
              class="issue"
              :class="{ clickable: !!issue.nodeId }"
              @click="selectIssue(issue)"
            >
              <strong v-if="issue.nodeId">{{ nodeName(issue.nodeId) }}: </strong>{{ issue.message }}
            </NAlert>
            <p class="muted small">{{ t('flows.editHelp') }}</p>
          </NTabPane>
        </NTabs>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* Category colors are tuned for light backgrounds; on dark ones icons mix in the text color to stay legible. */
.editor :deep([style*='--accent']) {
  --accent-fg: color-mix(in srgb, var(--accent) var(--flow-accent-strength, 100%), var(--flow-node-fg, #222));
}

.editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.editor-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(127, 127, 127, 0.18);
}

.name-input {
  flex: 0 1 220px;
  min-width: 110px;
}

.adapter-select {
  flex: 0 1 150px;
  min-width: 110px;
}

.bots-select {
  flex: 0 1 260px;
  min-width: 120px;
}

/* Groups: a dashed frame behind their nodes; the header moves the group. */
.flow-group {
  position: absolute;
  top: 0;
  left: 0;
  z-index: -1;
  box-sizing: border-box;
  border: 1.5px dashed rgba(127, 127, 127, 0.55);
  border-radius: 14px;
  background: rgba(127, 127, 127, 0.05);
  pointer-events: none;
}

.flow-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--flow-node-fg, #222);
  opacity: 0.75;
  cursor: grab;
  pointer-events: all;
  user-select: none;
}

.flow-group-head:active {
  cursor: grabbing;
}

.flow-group-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flow-group-count {
  font-weight: 500;
  opacity: 0.6;
}

.flow-group-rename {
  font: inherit;
  width: 160px;
  padding: 1px 6px;
  border-radius: 6px;
  border: 1px solid rgba(127, 127, 127, 0.4);
  background: var(--flow-node-bg, #fff);
  color: inherit;
}

/* A running edge is a moving dashed line; Vue Flow animates the dashes. */
.canvas :deep(.vue-flow__edge.animated path.vue-flow__edge-path) {
  stroke-dasharray: 6 4;
  animation-duration: 0.6s;
}

.canvas :deep(.vue-flow__edge.edge-ok path.vue-flow__edge-path),
.canvas :deep(.vue-flow__edge.edge-error path.vue-flow__edge-path) {
  transition: stroke 0.2s;
}

@media (max-width: 640px) {
  .editor-head {
    flex-wrap: wrap;
  }
}

.spacer {
  flex: 1;
}

.save-state {
  font-size: 12px;
  opacity: 0.6;
  white-space: nowrap;
}

.editor-body {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.canvas {
  flex: 1;
  min-height: 0;
  position: relative;
}

.canvas-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  opacity: 0.55;
  font-size: 14px;
  padding: 24px;
  text-align: center;
}

.panel {
  width: 340px;
  flex: none;
  overflow-y: auto;
  padding: 4px 14px 0;
  border-left: 1px solid rgba(127, 127, 127, 0.18);
  background: var(--flow-node-bg);
}

.node-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0 12px;
}

.node-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  color: var(--accent-fg);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}

.node-title {
  flex: 1;
  min-width: 0;
}

.node-name {
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-number {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-weight: 400;
  opacity: 0.5;
  margin-right: 8px;
}

.node-tabs {
  margin-bottom: 4px;
}

.node-tabs :deep(.n-tab-pane) {
  padding-top: 14px;
}

.node-foot {
  position: sticky;
  bottom: 0;
  margin: 8px -14px 0;
  padding: 12px 14px 14px;
  background: var(--flow-node-bg);
  border-top: 1px solid rgba(127, 127, 127, 0.14);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.node-note {
  display: flex;
  gap: 6px;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.75;
}

.note-icon {
  flex: none;
  margin-top: 3px;
}

.io-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 13px;
  border-bottom: 1px dashed rgba(127, 127, 127, 0.16);
}

.io-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.io-arrow {
  width: 8px;
  height: 10px;
  flex: none;
  background: #8c8c8c;
  clip-path: polygon(0 0, 100% 50%, 0 100%);
}

.io-name {
  flex: none;
  font-weight: 500;
}

.io-ref {
  font-size: 11px;
  color: #2080f0;
  white-space: nowrap;
}

.inputs-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.port-type {
  font-size: 11px;
  margin-left: 4px;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}

.vars-hint {
  margin: -6px 0 14px;
  line-height: 1.6;
}

.io-link {
  flex: 1;
  min-width: 0;
  text-align: right;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.json {
  margin: 4px 0 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.1);
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow: auto;
}

.narrow .side {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 10;
  background: var(--flow-node-bg);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}

.narrow .palette {
  left: 0;
}

.narrow .panel {
  right: 0;
  width: min(340px, 90vw);
}

.panel-empty {
  margin-top: 40px;
}

.section {
  margin: 16px 0 8px;
  font-size: 13px;
}

.muted {
  opacity: 0.65;
  font-size: 13px;
}

.small {
  font-size: 12px;
}

.issue {
  margin-bottom: 8px;
}

.issue.clickable {
  cursor: pointer;
}

.step-error {
  color: #d03050;
  font-size: 12px;
}

.dark :deep(.vue-flow__controls-button) {
  background: #2c2c32;
  border-bottom-color: #3a3a40;
  fill: #ddd;
}

.dark :deep(.vue-flow__minimap) {
  background: #1f1f23;
}
</style>
