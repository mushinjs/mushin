<script setup lang="ts">
import { ArrowBackOutline, ConstructOutline, InformationCircleOutline, ListOutline, PlayOutline, TrashOutline } from '@vicons/ionicons5'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { type Connection, type Edge, type Node, useVueFlow, VueFlow } from '@vue-flow/core'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import {
  NAlert, NButton, NEmpty, NForm, NFormItem, NIcon, NInput, NSelect, NTabPane, NTabs, NTag, useMessage,
} from 'naive-ui'
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, provide, type Ref, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { call, on } from '../api'
import { type CanvasNodeData, type FlowHighlight, flowEditorKey } from '../components/flow/context'
import FlowNodeCard from '../components/flow/FlowNodeCard.vue'
import { nodeIcon } from '../components/flow/icons'
import NodePalette from '../components/flow/NodePalette.vue'
import RunLogs, { type TestInput } from '../components/flow/RunLogs.vue'
import VarInput from '../components/flow/VarInput.vue'
import SchemaForm from '../components/SchemaForm.vue'
import { categoryColors, parseHandle, portColors, portsOf, refOf, refsIn, schemaDefaults, sysPorts } from '../flow'
import { useDataStore } from '../stores/data'
import { useTheme } from '../theme'
import type { FlowDoc, FlowIssue, NodeTypeInfo, RunTrace } from '../types'
import { clone, localize } from '../utils'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const data = useDataStore()
const { isDark } = useTheme()
const flowId = computed(() => String(route.params.id))

const { project, fitView, updateNodeInternals } = useVueFlow('flow-editor')

const types = ref(new Map<string, NodeTypeInfo>())
// Typed by assertion: Vue's deep ref unwrapping of Vue Flow's node types is too deep for TypeScript.
const nodes = ref([]) as Ref<Node<CanvasNodeData>[]>
const edges = ref([]) as Ref<Edge[]>
const name = ref('')
const description = ref('')
const bots = ref<string[]>([])
const issues = ref<FlowIssue[]>([])
const runs = ref<RunTrace[]>([])
const loaded = ref(false)
const saving = ref(false)
const savedSignature = ref('')
const selectedId = ref<string>()
const tab = ref<'node' | 'flow'>('flow')
const nodeTab = ref<'settings' | 'io'>('settings')
const highlight = ref<FlowHighlight>({ nodes: new Map(), edges: new Set() })
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
  }
}

const signature = () => JSON.stringify(toDoc())
const dirty = computed(() => loaded.value && signature() !== savedSignature.value)

/** Every edge means "run next": grey, traced edges green, invalid ones red. Direction is left to right, so no arrowheads. */
function edgeLook(edge: Pick<Edge, 'id'>): Partial<Edge> {
  const traced = highlight.value.edges.has(edge.id)
  const broken = issues.value.some((issue) => issue.edgeId === edge.id)
  const color = broken ? '#d03050' : traced ? '#18a058' : '#8c8c8c'
  return {
    type: 'default',
    animated: traced,
    style: { stroke: color, strokeWidth: 2 },
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
  issues.value = flow.issues
  nodes.value = flow.nodes.map((node) => ({
    id: node.id,
    type: 'mushin',
    position: { ...node.position },
    data: { typeId: node.type, label: node.label, config: node.config ?? {}, inputs: { ...node.inputs } },
  }))
  edges.value = flow.edges.map((edge) => ({ ...edge, ...edgeLook(edge) }))
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
  if (!info) return
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
    const result = await call<FlowDoc>('flows.update', { id: flowId.value, ...toDoc() })
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
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    save()
  }
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

// ---- runs and tests ----

let clearTimer: number | undefined
function showTrace(trace: RunTrace) {
  highlight.value = {
    nodes: new Map(trace.steps.map((step) => [step.nodeId, step.error ? 'error' : 'ok'])),
    edges: new Set(trace.edges),
  }
  restyleEdges()
  window.clearTimeout(clearTimer)
  clearTimer = window.setTimeout(() => {
    highlight.value = { nodes: new Map(), edges: new Set() }
    restyleEdges()
  }, 10_000)
}

const off = on('flows/run', (trace: RunTrace) => {
  if (trace.flowId !== flowId.value) return
  runs.value = [trace, ...runs.value].slice(0, 20)
  if (!trace.test) showTrace(trace)
})
onBeforeUnmount(off)

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
  window.clearTimeout(clearTimer)
  highlight.value = { nodes: new Map(), edges: new Set() }
  restyleEdges()
}

function selectFromLogs(nodeId: string) {
  if (!nodes.value.some((node) => node.id === nodeId)) return
  selectedId.value = nodeId
  tab.value = 'node'
}

const botOptions = computed(() => data.bots.map((bot) => ({ label: bot.name, value: bot.id })))
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
      <NodePalette v-if="showPalette" class="side" :types="[...types.values()]" @add="(typeId: string) => addNode(typeId)" />

      <div class="main">
        <div ref="canvas" class="canvas" @dragover.prevent @drop.prevent="onDrop">
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
            @nodes-initialized="onNodesInitialized"
            @node-click="onNodeClick"
            @pane-click="selectedId = undefined"
          >
            <Background :gap="20" :pattern-color="isDark ? '#3a3a40' : '#d9d9d9'" />
            <Controls />
            <MiniMap v-if="!narrow" pannable zoomable :node-color="minimapColor" :mask-color="isDark ? 'rgba(20, 20, 24, 0.7)' : undefined" />
          </VueFlow>
          <div v-if="loaded && !nodes.length" class="canvas-empty">{{ t('flows.emptyCanvas') }}</div>
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

.bots-select {
  flex: 0 1 260px;
  min-width: 120px;
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
