/** Loading the flow onto the canvas, saving it back, and the flow-wide settings in the header. */
import { computed, onBeforeUnmount, watch } from 'vue'
import { call, on } from '../../../api'
import { schemaDefaults } from '../../../flow'
import { useAgentSceneStore } from '../../../stores/agentScene'
import type { FlowDoc, FlowIssue, NodeTypeInfo, RunTrace } from '../../../types'
import { clone, localize } from '../../../utils'
import type { EditorState } from './state'
import type { useEditing } from './useEditing'
import type { useGroups } from './useGroups'
import type { useRuns } from './useRuns'
import type { useTriggerOrder } from './useTriggerOrder'

export function useDocument(
  s: EditorState,
  parts: {
    groups: ReturnType<typeof useGroups>
    editing: ReturnType<typeof useEditing>
    runs: ReturnType<typeof useRuns>
    order: ReturnType<typeof useTriggerOrder>
  },
) {
  const { t, locale, message, flowId, data, nodes, edges, types, loaded, saving, dirty, adapter, bots, issues, blockedSlots } = s

  // Tells the Agent which flow is open and how many problems it has.
  const agentScene = useAgentSceneStore()
  watch([s.name, issues, flowId], () => agentScene.publish({
    label: s.name.value,
    state: { errors: s.errorCount.value, warnings: s.warningCount.value },
    resource: `flow:${flowId.value}`,
  }), { immediate: true })
  onBeforeUnmount(() => agentScene.publish(undefined))

  let savedAt = 0
  let pendingFit = false
  /** A node to center on once the canvas is ready, instead of fitting the whole flow. */
  let pendingFocus: string | undefined

  /** Puts a flow from the server on the canvas; `fit` re-centers the view. */
  function apply(flow: FlowDoc, fit: boolean) {
    s.name.value = flow.name
    s.description.value = flow.description ?? ''
    bots.value = [...flow.bots]
    s.enabled.value = flow.enabled !== false
    adapter.value = flow.adapter
    issues.value = flow.issues
    blockedSlots.value = flow.blocked ?? []
    nodes.value = flow.nodes.map((node) => ({
      id: node.id,
      type: 'mushin',
      position: { ...node.position },
      data: {
        typeId: node.type,
        label: node.label,
        // Defaults the settings form would fill in anyway, so opening a node does not count as an edit.
        config: { ...schemaDefaults(types.value.get(node.type)?.configSchema), ...node.config },
        inputs: { ...node.inputs },
        ...(node.skip ? { skip: true } : {}),
        ...(node.priority ? { priority: node.priority } : {}),
        ...(node.intercept ? { intercept: node.intercept } : {}),
      },
    }))
    edges.value = flow.edges.map((edge) => ({ ...edge, ...s.edgeLook(edge) }))
    s.groups.value = clone(flow.groups ?? [])
    parts.groups.syncGroups()
    if (s.selectedId.value && !flow.nodes.some((node) => node.id === s.selectedId.value)) s.selectedId.value = undefined
    savedAt = flow.updatedAt
    s.savedSignature.value = s.signature()
    loaded.value = true
    if (fit) pendingFit = true
  }

  function onNodesInitialized() {
    if (!pendingFit) return
    pendingFit = false
    const focus = pendingFocus
    pendingFocus = undefined
    // A frame later, once the canvas has its final size; fitting right away could zoom all the way out.
    requestAnimationFrame(() => (focus ? parts.editing.focusNode(focus, false) : s.flow.fitView({ padding: 0.2, maxZoom: 1.2 })))
  }

  async function load() {
    loaded.value = false
    const [typeList, flow, recent] = await Promise.all([
      call<NodeTypeInfo[]>('flows.nodeTypes'),
      call<FlowDoc>('flows.get', { id: flowId.value }),
      call<RunTrace[]>('flows.runs', { id: flowId.value }),
    ])
    types.value = new Map(typeList.map((type) => [type.type, type]))
    s.runs.value = [...recent].reverse()
    apply(flow, true)
    parts.runs.loadBreakpoints()
    if (typeof s.route.query.run === 'string') void parts.runs.openRun(s.route.query.run)
    // A link such as /flows/<id>?node=<node id> opens with that node selected.
    const target = typeof s.route.query.node === 'string' ? s.route.query.node : undefined
    if (target && flow.nodes.some((node) => node.id === target)) {
      s.selectNode(target)
      pendingFocus = target
      // Opening another flow in the same editor may not fire "nodes initialized"; focus once its nodes have a size.
      const started = Date.now()
      const wait = () => {
        if (pendingFocus !== target) return
        const node = s.flow.findNode(target)
        if (node?.dimensions.width) {
          pendingFocus = undefined
          pendingFit = false
          parts.editing.focusNode(target, false)
        } else if (Date.now() - started < 3000) {
          setTimeout(wait, 50)
        }
      }
      setTimeout(wait, 50)
    }
  }

  const reload = () => load().catch((error) => message.error(error.message))

  // Someone else (usually the Agent) changed the flow: follow along unless there are local edits.
  const offChanged = on('flows/changed', async () => {
    if (!loaded.value || dirty.value || saving.value) return
    try {
      const flow = await call<FlowDoc>('flows.get', { id: flowId.value })
      if (flow.updatedAt !== savedAt && !dirty.value) apply(flow, false)
    } catch {}
  })
  onBeforeUnmount(offChanged)
  watch(flowId, reload)

  async function save() {
    if (saving.value) return
    saving.value = true
    try {
      const result = await call<FlowDoc>('flows.update', { id: flowId.value, ...s.toDoc(), adapter: s.currentAdapter.value ?? '' })
      adapter.value = result.adapter
      issues.value = result.issues
      blockedSlots.value = result.blocked ?? []
      s.restyleEdges()
      parts.order.loadCompeting()
      savedAt = result.updatedAt
      s.savedSignature.value = s.signature()
      const errors = result.issues.filter((issue) => issue.severity === 'error').length
      if (errors) message.warning(t('flows.savedWithErrors', errors))
      else message.success(t('common.saved'))
    } catch (error) {
      message.error((error as Error).message)
    } finally {
      saving.value = false
    }
  }

  /** Turning a flow on or off takes effect at once and leaves unsaved edits alone. */
  async function setEnabled(value: boolean) {
    s.toggling.value = true
    try {
      const result = await call<FlowDoc>('flows.update', { id: flowId.value, enabled: value })
      s.enabled.value = result.enabled !== false
      savedAt = result.updatedAt
      message.success(value ? t('flows.enabledNow') : t('flows.disabledNow'))
    } catch (error) {
      message.error((error as Error).message)
    } finally {
      s.toggling.value = false
    }
  }

  const adapterOptions = computed(() => data.adapters.map((item) => ({ label: localize(item.displayName, locale.value) || item.id, value: item.id })))
  function setAdapter(value: string | null) {
    adapter.value = value ?? undefined
    // Bots on another adapter cannot run this flow's adapter-specific nodes.
    if (value) bots.value = bots.value.filter((id) => data.bots.find((bot) => bot.id === id)?.adapter.type === value)
  }
  // Bots of other adapters are left out; ones already picked stay so they can be removed.
  const botOptions = computed(() => data.bots
    .filter((bot) => !s.currentAdapter.value || bot.adapter.type === s.currentAdapter.value || bots.value.includes(bot.id))
    .map((bot) => ({ label: bot.name, value: bot.id })))

  function selectIssue(issue: FlowIssue) {
    if (issue.nodeId) s.selectNode(issue.nodeId)
  }

  return { load, reload, onNodesInitialized, save, setEnabled, adapterOptions, setAdapter, botOptions, selectIssue }
}
