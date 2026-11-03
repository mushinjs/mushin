/**
 * The order of triggers that compete for the same message on a bot: shown in a trigger's settings,
 * previewed for unsaved edits, and reordered by dragging.
 */
import { ref, watch } from 'vue'
import { call } from '../../../api'
import type { FlowDoc, Intercept, TriggerSlot } from '../../../types'
import type { EditorState } from './state'
import type { useEditing } from './useEditing'

/** Event and schedule triggers have no "let other plugins answer too"; they pass on unless told not to. */
export const intercepts: Intercept[] = ['none', 'flow', 'flows', 'global']

export function useTriggerOrder(s: EditorState, editing: ReturnType<typeof useEditing>) {
  const { message, flowId, selected, selectedIsTrigger, nodes, bots } = s

  const orderBot = ref<string>()
  const competing = ref<TriggerSlot[]>([])
  const pluginsAfter = ref<string[]>([])
  const ordering = ref(false)

  watch(bots, (list) => {
    if (!orderBot.value || !list.includes(orderBot.value)) orderBot.value = list[0]
  }, { immediate: true })

  async function loadCompeting() {
    const node = selected.value
    if (!node || !selectedIsTrigger.value || !orderBot.value) {
      competing.value = []
      return
    }
    try {
      // Unsaved edits are previewed: the server orders the triggers as if the flow were saved like this.
      const { nodes: draftNodes, edges: draftEdges, bots: draftBots } = s.toDoc()
      const result = await call<{ triggers: TriggerSlot[]; plugins: string[] }>('flows.triggers', {
        bot: orderBot.value,
        flow: flowId.value,
        node: node.id,
        ...(s.dirty.value ? { draft: { nodes: draftNodes, edges: draftEdges, bots: draftBots } } : {}),
      })
      competing.value = result.triggers
      pluginsAfter.value = result.plugins
      // The canvas marks this trigger by the same preview, so the two agree before saving too.
      const own = result.triggers.find((slot) => slot.flowId === flowId.value && slot.nodeId === node.id)
      const bot = orderBot.value
      s.blockedSlots.value = [
        ...s.blockedSlots.value.filter((slot) => !(slot.nodeId === node.id && slot.botId === bot)),
        ...(own?.blockedBy ? [{ ...own, botId: bot }] : []),
      ]
    } catch {
      competing.value = []
    }
  }
  watch(() => [s.selectedId.value, orderBot.value, selectedIsTrigger.value], loadCompeting)

  // Follow edits (a new priority, a renamed command…) while the order list is open, a moment after typing stops.
  let orderTimer: number | undefined
  watch(() => (selectedIsTrigger.value ? s.signature() : ''), (next, previous) => {
    if (!next || next === previous) return
    window.clearTimeout(orderTimer)
    orderTimer = window.setTimeout(loadCompeting, 300)
  })

  async function applyOrder(list: TriggerSlot[]) {
    ordering.value = true
    try {
      const result = await call<{ flowId: string; nodeId: string; priority: number }[]>('flows.setTriggerOrder', {
        order: list.map((slot) => ({ flowId: slot.flowId, nodeId: slot.nodeId })),
      })
      // Keep this flow's canvas in step with the priorities just saved for it.
      const wasDirty = s.dirty.value
      for (const item of result.filter((entry) => entry.flowId === flowId.value)) {
        nodes.value = nodes.value.map((node) => (node.id === item.nodeId ? { ...node, data: { ...node.data!, priority: item.priority || undefined } } : node))
      }
      if (!wasDirty) s.savedSignature.value = s.signature()
      await loadCompeting()
      const flow = await call<FlowDoc>('flows.get', { id: flowId.value })
      s.blockedSlots.value = flow.blocked ?? []
      s.issues.value = flow.issues
    } catch (error) {
      message.error((error as Error).message)
    } finally {
      ordering.value = false
    }
  }

  /** Moves a trigger up or down among the competing ones by rewriting their priorities. */
  async function moveTrigger(index: number, by: -1 | 1) {
    const list = [...competing.value]
    const target = index + by
    if (target < 0 || target >= list.length) return
    ;[list[index], list[target]] = [list[target], list[index]]
    await applyOrder(list)
  }

  // Dragging a row of the order list onto another puts it in that row's place.
  const dragFrom = ref<number>()
  const dragOver = ref<number>()

  function onOrderDrop(index: number) {
    const from = dragFrom.value
    dragFrom.value = undefined
    dragOver.value = undefined
    if (from === undefined || from === index) return
    const list = [...competing.value]
    const [moved] = list.splice(from, 1)
    list.splice(index, 0, moved)
    // Show the new order at once; the saved priorities follow.
    competing.value = list
    applyOrder(list)
  }

  /** The priority field also follows the mouse wheel: up raises it, down lowers it. */
  function onPriorityWheel(event: WheelEvent) {
    if (!selected.value || !event.deltaY) return
    const next = (selected.value.data!.priority ?? 0) + (event.deltaY < 0 ? 1 : -1)
    editing.updateSelected({ priority: next || undefined })
  }

  /** Opens a trigger: on this canvas, or in its own flow. */
  function openTrigger(slot: { flowId: string; nodeId: string }) {
    if (slot.flowId === flowId.value) {
      editing.focusNode(slot.nodeId)
      return
    }
    s.router.push({ path: `/flows/${slot.flowId}`, query: { node: slot.nodeId } })
  }

  return { orderBot, competing, pluginsAfter, ordering, loadCompeting, moveTrigger, dragFrom, dragOver, onOrderDrop, onPriorityWheel, openTrigger }
}
