/**
 * The flow editor's shared state: the document on the canvas, what is selected and which panels
 * are open, plus the small helpers every part of the editor reads. The other modules here add the
 * behaviour on top; `useFlowEditorView` puts them together.
 */
import { type Edge, type Node, useVueFlow } from '@vue-flow/core'
import { useConfirm, useToast } from '@mushinjs/ui'
import { computed, type Ref, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useDataStore } from '../../../stores/data'
import type { FlowDoc, FlowGroupDoc, FlowIssue, FlowPause, FlowRunInfo, NodeTypeInfo, RunTrace } from '../../../types'
import { readPath, splitName } from '../../../flow'
import { localize } from '../../../utils'
import type { CanvasNodeData, FlowHighlight, RunStatus } from '../context'
import type RunLogs from '../RunLogs.vue'
import { checkNode, upstreamOf } from './checks'

// A collapsed group is drawn as one box node (type `mushinGroup`, id `group:<group id>`) with its
// nodes hidden; connections that cross the group are drawn to the box as `virt:<edge id>`. Boxes
// and those edges exist only on the canvas and are never saved.
export const BOX = 'mushinGroup'
export const isBox = (node: { type?: string }) => node.type === BOX
export const isVirtual = (edge: { id: string }) => edge.id.startsWith('virt:')
/** Edges drawn round a skipped step, from the steps before it to the ones after its first exit. Never saved. */
export const BYPASS = 'bypass:'

const edgeColors: Record<RunStatus, string> = { running: '#2080f0', ok: '#18a058', error: '#d03050', skipped: '#18a058', paused: '#f0a020' }

/** Below this width the palette and panel float over the canvas instead of squeezing it. */
const NARROW = 1000

export function createEditorState() {
  const { t, locale } = useI18n()
  const route = useRoute()
  const router = useRouter()
  const message = useToast()
  const dialog = useConfirm()
  const data = useDataStore()
  const flow = useVueFlow('flow-editor')
  const flowId = computed(() => String(route.params.id))

  const types = ref(new Map<string, NodeTypeInfo>())
  // Typed by assertion: Vue's deep ref unwrapping of Vue Flow's node types is too deep for TypeScript.
  const nodes = ref([]) as Ref<Node<CanvasNodeData>[]>
  const edges = ref([]) as Ref<Edge[]>
  /** Nodes framed together; only the editor uses them. */
  const groups = ref<FlowGroupDoc[]>([])
  const name = ref('')
  const description = ref('')
  const bots = ref<string[]>([])
  const enabled = ref(true)
  const toggling = ref(false)
  /** The adapter saved on the flow; see `currentAdapter` for the one in effect. */
  const adapter = ref<string>()
  const issues = ref<FlowIssue[]>([])
  const blockedSlots = ref<NonNullable<FlowDoc['blocked']>>([])

  const runs = ref<RunTrace[]>([])
  /** The run the logs panel shows; node cards show its inputs and outputs on hover. */
  const logsRun = ref<string>()
  /** A run on a bot opened from its run list (`?run=<id>`), drawn on the canvas until closed. */
  const viewing = ref<FlowRunInfo>()
  /** Nodes test runs pause before; kept in this browser for each flow. */
  const breakpoints = ref(new Set<string>())
  /** The test run waiting at a breakpoint. */
  const paused = ref<FlowPause>()
  const testing = ref(false)
  /** The node a single-step run is executing right now. */
  const executing = ref<string>()
  const highlight = ref<FlowHighlight>({ nodes: new Map(), edges: new Map() })
  /** Test case count and failures of the last run, shown on the tests tab. */
  const testStatus = ref({ failed: 0, total: 0 })
  const uncovered = ref(new Set<string>())
  /** The handle under the pointer; its connections and the handles at their other ends light up. */
  const hoveredHandle = ref<{ node: string; handle: string }>()
  /** The edge under the pointer; it and the handles at both its ends light up. */
  const hoveredEdge = ref<string>()
  /** What lights up for the hovered handle or edge: those edges, and the handles they join as `node:handle`. */
  const linked = computed(() => {
    const result = { edges: new Set<string>(), handles: new Set<string>() }
    const handle = hoveredHandle.value
    const edgeId = hoveredEdge.value
    if (!handle && !edgeId) return result
    for (const edge of edges.value) {
      const [from, to] = [[edge.source, edge.sourceHandle], [edge.target, edge.targetHandle]]
      const ends = edge.id === edgeId ? [from, to]
        : handle && from[0] === handle.node && from[1] === handle.handle ? [to]
          : handle && to[0] === handle.node && to[1] === handle.handle ? [from] : []
      if (!ends.length) continue
      result.edges.add(edge.id)
      for (const [node, port] of ends) result.handles.add(`${node}:${port}`)
    }
    return result
  })

  const loaded = ref(false)
  const saving = ref(false)
  const savedSignature = ref('')
  const selectedId = ref<string>()
  const tab = ref<'node' | 'flow'>('flow')
  const nodeTab = ref<'settings' | 'io'>('settings')

  const canvas = ref<HTMLElement>()
  const root = ref<HTMLElement>()
  const logs = ref<InstanceType<typeof RunLogs>>()
  const width = ref(1200)
  const narrow = computed(() => width.value < NARROW)
  const showPalette = ref(true)
  const showPanel = ref(true)
  const showLogs = ref(true)
  const logsTab = ref<'logs' | 'tests'>('logs')
  /** The editor fills the window, over the app's sidebar, top bar and Agent. */
  const immersive = ref(false)

  const realNodes = computed(() => nodes.value.filter((node) => !isBox(node)))
  const order = computed(() => new Map(realNodes.value.map((node, index) => [node.id, index])))

  /** A setting's or input's name as the panel shows it. */
  function fieldLabel(info: NodeTypeInfo, field: string) {
    if (field.startsWith('in:')) {
      const port = info.inputs.find((item) => item.name === field.slice(3))
      return port ? portLabel(port) : field.slice(3)
    }
    const schema = info.configSchema?.properties?.[field]
    return schema?.['x-i18n']?.[locale.value]?.title ?? schema?.title ?? field
  }

  /** The latest value a reference gave in a run, for checking it against what a setting needs. */
  function sampleOf(head: string, name: string) {
    const { first, path } = splitName(name)
    for (const run of runs.value) {
      const step = run.steps.findLast((item) => item.nodeId === head)
      if (step?.outputs && first in step.outputs) return readPath(step.outputs[first], path)
    }
    return undefined
  }

  /** Problems in each node's settings as they are typed, before saving; see `checks.ts`. */
  const checks = computed<FlowIssue[]>(() => {
    const all = new Map(realNodes.value.map((node) => [node.id, { id: node.id, typeId: node.data!.typeId, config: node.data!.config, inputs: node.data!.inputs }]))
    const out: FlowIssue[] = []
    for (const node of all.values()) {
      const info = types.value.get(node.typeId)
      if (!info) continue
      for (const check of checkNode(node, info, { nodes: all, types: types.value, upstream: upstreamOf(node.id, edges.value), sampleOf })) {
        const params: Record<string, string> = { ...check.params }
        if (params.node) params.node = params.node === 'sys' ? t('flows.varsMessage') : nodeName(params.node)
        if (params.field) params.field = fieldLabel(info, params.field)
        if (params.type) params.type = t(`flows.check.types.${params.type}`)
        if (params.refType) params.refType = t(`flows.check.types.${params.refType}`)
        out.push({ severity: check.severity, nodeId: node.id, field: check.field, message: t(`flows.check.${check.code}`, params) })
      }
    }
    return out
  })
  /**
   * The server's issues from the last save and the editor's own checks. The server's notes on
   * references are left out: the checks above say the same, and stay current while typing.
   */
  const allIssues = computed(() => [
    ...issues.value.filter((issue) => !(issue.nodeId && issue.message.includes(' references {{'))),
    ...checks.value,
  ])
  const issuesByNode = computed(() => {
    const map = new Map<string, FlowIssue[]>()
    for (const issue of allIssues.value) {
      if (issue.nodeId) map.set(issue.nodeId, [...(map.get(issue.nodeId) ?? []), issue])
    }
    return map
  })
  const errorCount = computed(() => allIssues.value.filter((issue) => issue.severity === 'error').length)
  const warningCount = computed(() => allIssues.value.length - errorCount.value)

  const selected = computed(() => nodes.value.find((node) => node.id === selectedId.value))
  const selectedInfo = computed(() => selected.value && types.value.get(selected.value.data!.typeId))
  const selectedIsTrigger = computed(() => selectedInfo.value?.kind === 'trigger')

  /** The flow's adapter: the one set on it, else the one its bots all use, else the only one installed. */
  const currentAdapter = computed(() => {
    if (adapter.value) return adapter.value
    const used = new Set(bots.value.map((id) => data.bots.find((bot) => bot.id === id)?.adapter.type).filter(Boolean))
    if (used.size === 1) return [...used][0]
    return data.adapters.length === 1 ? data.adapters[0].id : undefined
  })
  const adapterName = (id: string) => localize(data.adapters.find((item) => item.id === id)?.displayName, locale.value) || id

  const typeTitle = (typeId: string) => localize(types.value.get(typeId)?.title, locale.value) || typeId
  const nodeName = (id: string) => {
    const node = nodes.value.find((item) => item.id === id)
    return node ? node.data!.label || typeTitle(node.data!.typeId) : id
  }
  const nodeType = (id: string) => nodes.value.find((item) => item.id === id)?.data!.typeId
  const botName = (id: string) => data.bots.find((bot) => bot.id === id)?.name ?? id
  const portLabel = (port: { name: string; title?: any }) => localize(port.title, locale.value) || port.name
  const groupOf = (groupId: string | undefined) => groups.value.find((group) => group.id === groupId)

  function toDoc() {
    return {
      name: name.value,
      description: description.value,
      adapter: adapter.value ?? '',
      bots: bots.value,
      nodes: realNodes.value.map((node) => ({
        id: node.id,
        type: node.data!.typeId,
        ...(node.data!.label ? { label: node.data!.label } : {}),
        position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
        config: node.data!.config,
        ...(node.data!.inputs && Object.keys(node.data!.inputs).length ? { inputs: node.data!.inputs } : {}),
        ...(node.data!.skip ? { skip: true } : {}),
        ...(node.data!.priority ? { priority: node.data!.priority } : {}),
        ...(node.data!.intercept ? { intercept: node.data!.intercept } : {}),
      })),
      edges: edges.value.filter((edge) => !isVirtual(edge)).map((edge) => ({
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

  /**
   * Every edge means "run next". Grey by default; during a run the edge into a running node is a
   * moving dashed line, then green or red once that node succeeds or fails. Invalid edges are red
   * and dashed. Direction is left to right, so no arrowheads.
   */
  function edgeLook(edge: Pick<Edge, 'id' | 'source' | 'target'>): Partial<Edge> {
    // A connection drawn to a collapsed group looks like the real one.
    const id = edge.id.replace(/^virt:/, '')
    const bypass = id.startsWith(BYPASS)
    const status = highlight.value.edges.get(id)
    const broken = issues.value.some((issue) => issue.edgeId === id)
    // A skipped node's own connections are dashed; runs go round it on the bypass drawn instead.
    const skipped = !bypass && [edge.source, edge.target].some((node) => flow.findNode(node)?.data?.skip)
    const color = status ? edgeColors[status] : broken ? '#d03050' : '#8c8c8c'
    const dashed = (broken && !status) || skipped
    return {
      type: 'default',
      animated: status === 'running',
      updatable: !edge.id.startsWith('virt:'),
      class: [status ? `edge-${status}` : '', skipped ? 'edge-skipped' : '', bypass ? 'edge-bypass' : '', linked.value.edges.has(edge.id) ? 'edge-linked' : ''].filter(Boolean).join(' ') || undefined,
      style: { stroke: color, strokeWidth: status ? 2.5 : 2, ...(dashed ? { strokeDasharray: skipped ? '6 5' : '4 4' } : {}), ...(skipped && !status ? { opacity: 0.6 } : {}) },
    }
  }

  function restyleEdges() {
    edges.value = edges.value.map((edge) => ({ ...edge, ...edgeLook(edge) }))
  }

  /** A new edge between two handles, styled for the canvas. */
  function link(source: string, sourceHandle: string, target: string, targetHandle = 'exec') {
    const edge = { id: `e-${Math.random().toString(36).slice(2, 8)}`, source, sourceHandle, target, targetHandle }
    return { ...edge, ...edgeLook(edge) }
  }

  /** On a narrow screen only one side panel shows at a time, floating over the canvas. */
  function openPanel() {
    showPanel.value = true
    if (narrow.value) showPalette.value = false
  }

  /** Opens a node's settings without moving the canvas. */
  function selectNode(id: string) {
    selectedId.value = id
    tab.value = 'node'
  }

  return {
    t, locale, route, router, message, dialog, data, flow, flowId,
    types, nodes, edges, groups, name, description, bots, enabled, toggling, adapter, issues, blockedSlots,
    runs, logsRun, viewing, breakpoints, paused, testing, executing, highlight, testStatus, uncovered, hoveredHandle, hoveredEdge, linked,
    loaded, saving, savedSignature, selectedId, tab, nodeTab,
    canvas, root, logs, width, narrow, showPalette, showPanel, showLogs, logsTab, immersive,
    realNodes, order, allIssues, issuesByNode, errorCount, warningCount, selected, selectedInfo, selectedIsTrigger,
    currentAdapter, adapterName, typeTitle, nodeName, nodeType, botName, portLabel, groupOf,
    toDoc, signature, dirty, edgeLook, restyleEdges, link, openPanel, selectNode,
  }
}

export type EditorState = ReturnType<typeof createEditorState>
