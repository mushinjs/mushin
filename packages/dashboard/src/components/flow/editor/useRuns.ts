/**
 * Runs on the canvas: test runs started here, runs going on on a bot, a run opened from a bot's run
 * list, and the debugger that pauses test runs at breakpoints.
 */
import { computed, nextTick, onBeforeUnmount, type Ref, ref, watch } from 'vue'
import { call, on } from '../../../api'
import { portsOf } from '../../../flow'
import { isLive, useRunsStore } from '../../../stores/runs'
import type { FlowPause, FlowRunInfo, RunStep, RunTrace, TestOption, TraceStep } from '../../../types'
import type { FlowHighlight, RunStatus } from '../context'
import type { TestInput } from '../RunLogs.vue'
import type { EditorState } from './state'

/** Runs kept in the logs. */
const KEEP = 20

export function useRuns(s: EditorState, actions: { save: () => Promise<void>; sample: Ref<{ bot: string; id: string; channel: string } | undefined> }) {
  const { t, message, flowId, runs, logsRun, viewing, breakpoints, paused, testing, executing, highlight, nodes, edges, realNodes, types, logs } = s

  let clearTimer: number | undefined
  /** The run being drawn live from its steps, until its trace arrives. */
  let liveRun: string | undefined

  /** Puts a run at the top of the logs, replacing an older copy of it. */
  const keep = (trace: RunTrace) => (runs.value = [trace, ...runs.value.filter((item) => item.id !== trace.id)].slice(0, KEEP))

  function clearHighlight() {
    window.clearTimeout(clearTimer)
    liveRun = undefined
    highlight.value = { nodes: new Map(), edges: new Map() }
    s.restyleEdges()
  }

  /**
   * Whether the logs follow the latest run. Once an older run is picked there, runs coming in do not
   * draw over it, so the canvas keeps showing the run the logs show.
   */
  const following = () => !logsRun.value || logsRun.value === runs.value[0]?.id

  /** Draws a finished run: each edge takes the state of the node it led to. With `stay`, it does not fade. */
  function showTrace(trace: RunTrace, stay = false) {
    const nodeStatus = new Map<string, RunStatus>(trace.steps.map((step) => [step.nodeId, step.error ? 'error' : step.skipped ? 'skipped' : 'ok']))
    const target = new Map(edges.value.map((edge) => [edge.id, edge.target]))
    const edgeStatus = new Map<string, RunStatus>(trace.edges.map((id) => {
      const status = nodeStatus.get(target.get(id) ?? '')
      return [id, status === 'skipped' ? 'ok' : status ?? (trace.error ? 'error' : 'ok')]
    }))
    liveRun = undefined
    highlight.value = { nodes: nodeStatus, edges: edgeStatus }
    s.restyleEdges()
    window.clearTimeout(clearTimer)
    // A run opened from the run list or picked in the logs stays drawn; others fade after a while.
    if (!stay && viewing.value?.id !== trace.id) clearTimer = window.setTimeout(clearHighlight, 10_000)
  }

  /** What a node took and gave in the run the logs show: its last step there. */
  function stepOf(nodeId: string): TraceStep | undefined {
    // The node a test run is paused before shows the inputs it is about to get.
    if (paused.value?.nodeId === nodeId) return { nodeId, ms: 0, inputs: paused.value.inputs }
    const trace = runs.value.find((item) => item.id === logsRun.value) ?? runs.value[0]
    return trace?.steps.findLast((step) => step.nodeId === nodeId)
  }

  /** The selected node's step in the latest run that reached it. */
  const lastStep = computed(() => {
    for (const run of runs.value) {
      const step = run.steps.find((item) => item.nodeId === s.selectedId.value)
      if (step) return { run, step }
    }
    return undefined
  })

  /** A node of a run in this flow started or finished: update the canvas while the run goes on. */
  function showStep(step: RunStep) {
    window.clearTimeout(clearTimer)
    if (liveRun !== step.runId) {
      liveRun = step.runId
      highlight.value = { nodes: new Map(), edges: new Map() }
    }
    const next: FlowHighlight = { nodes: new Map(highlight.value.nodes), edges: new Map(highlight.value.edges) }
    next.nodes.set(step.nodeId, step.status)
    if (step.edgeId) next.edges.set(step.edgeId, step.status === 'skipped' ? 'ok' : step.status)
    highlight.value = next
    s.restyleEdges()
  }

  const offRun = on('flows/run', (trace: RunTrace) => {
    if (trace.flowId !== flowId.value) return
    // Read before the run joins the logs, which moves the latest run.
    const follow = following()
    keep(trace)
    if (viewing.value && viewing.value.id !== trace.id) return
    if (follow && (!trace.test || liveRun === trace.id)) showTrace(trace)
  })
  const offStep = on('flows/step', (step: RunStep) => {
    if (step.flowId !== flowId.value) return
    // While a run from the run list is open, other runs do not draw over it.
    if (viewing.value && viewing.value.id !== step.runId) return
    // Nor do they while an older run is picked in the logs, except the test run just started here.
    if (!following() && liveRun !== step.runId && !(step.test && testing.value)) return
    showStep(step)
  })

  // ---- a run from a bot's run list ----

  const runsStore = useRunsStore()
  const now = ref(Date.now())
  const clock = window.setInterval(() => (now.value = Date.now()), 1000)

  /** Shows a run in the logs and on the canvas; a run going on keeps updating there. */
  async function openRun(id: string) {
    let run: FlowRunInfo & { trace: RunTrace }
    try {
      run = await call<FlowRunInfo & { trace: RunTrace }>('flows.run', { id })
    } catch {
      message.warning(t('runs.notFound'))
      return
    }
    if (run.flowId !== flowId.value) return
    const { trace, ...info } = run
    viewing.value = info
    keep(trace)
    showTrace(trace)
    // Steps still to come draw on top of the ones so far, starting with the node working now.
    if (isLive(info)) {
      liveRun = trace.id
      const current = info.node?.id
      if (current && !trace.steps.some((step) => step.nodeId === current)) {
        const states = new Map(highlight.value.nodes)
        states.set(current, 'running')
        highlight.value = { ...highlight.value, nodes: states }
      }
    }
    nextTick(() => logs.value?.focus(trace.id))
  }

  let refreshing = false
  let again = false
  /** Fetches the open run's trace again, so the logs follow it while it goes on. */
  async function refreshViewing() {
    if (refreshing) {
      again = true
      return
    }
    refreshing = true
    try {
      const run = await call<FlowRunInfo & { trace: RunTrace }>('flows.run', { id: viewing.value!.id })
      const { trace, ...info } = run
      if (viewing.value?.id !== info.id) return
      viewing.value = info
      runs.value = runs.value.map((item) => (item.id === trace.id ? trace : item))
      if (!isLive(info)) showTrace(trace)
    } catch {} finally {
      refreshing = false
      if (again && viewing.value) {
        again = false
        void refreshViewing()
      }
    }
  }

  const offActivity = runsStore.subscribe((run) => {
    if (viewing.value?.id === run.id) void refreshViewing()
  })

  function closeRun() {
    viewing.value = undefined
    clearHighlight()
    const { run: _, ...query } = s.route.query
    s.router.replace({ query })
  }

  function stopViewing() {
    const run = viewing.value
    if (!run) return
    s.dialog.warning({
      title: t('runs.stopTitle'),
      content: t('runs.stopConfirm', { flow: run.flowName }),
      positiveText: t('runs.stop'),
      negativeText: t('common.cancel'),
      onPositiveClick: async () => {
        try {
          await call('flows.stop', { id: run.id })
        } catch (error) {
          message.error((error as Error).message)
        }
      },
    })
  }

  const viewingBot = computed(() => s.data.bots.find((bot) => bot.id === viewing.value?.botId))
  watch(() => s.route.query.run, (id) => {
    if (s.loaded.value && typeof id === 'string' && id !== viewing.value?.id) void openRun(id)
  })

  /** Runs the logs mark as going on. */
  const liveRuns = computed(() => [...(viewing.value && isLive(viewing.value) ? [viewing.value.id] : []), ...(paused.value ? [paused.value.runId] : [])])

  // ---- test runs ----

  const test = ref<TestInput>({
    text: '', useSample: true, userName: '', userId: '', groupId: '', private: false, mentioned: false, role: 'user', groupRole: '', mode: 'message', eventName: '', eventData: '{}', schedule: '', replies: '',
  })
  const schedules = computed(() => nodes.value
    .filter((node) => node.data?.typeId === 'trigger.schedule')
    .map((node) => ({ id: node.id, name: s.nodeName(node.id) })))

  /** Quick choices for the test settings, from the nodes' configs (a permission check's lists, a command's arguments). */
  const quickTests = ref<TestOption[]>([])
  let quickTimer: ReturnType<typeof setTimeout> | undefined
  watch(() => JSON.stringify(realNodes.value.map((node) => [node.id, node.data?.typeId, node.data?.config])), () => {
    clearTimeout(quickTimer)
    quickTimer = setTimeout(async () => {
      const list = realNodes.value
        .filter((node) => node.data?.typeId && types.value.get(node.data.typeId))
        .map((node) => ({ id: node.id, type: node.data!.typeId, config: node.data!.config }))
      try {
        quickTests.value = list.length ? await call<TestOption[]>('flows.testOptions', { nodes: list }) : []
      } catch {
        quickTests.value = []
      }
    }, 400)
  }, { immediate: true })
  onBeforeUnmount(() => clearTimeout(quickTimer))

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
    // A picked sample runs as the real message; the pretended role still applies when set.
    if (actions.sample.value && test.value.useSample) {
      return { sample: actions.sample.value, ...(test.value.role !== 'user' ? { role: test.value.role } : {}), ...common }
    }
    if (!text.trim()) return
    const roles = { ...(test.value.role !== 'user' ? { role: test.value.role } : {}), ...(test.value.groupRole && !test.value.private ? { groupRole: test.value.groupRole } : {}) }
    const ids = { ...(test.value.userId.trim() ? { userId: test.value.userId.trim() } : {}), ...(test.value.groupId.trim() && !test.value.private ? { groupId: test.value.groupId.trim() } : {}) }
    return { text, userName, private: test.value.private, mentioned, ...ids, ...roles, ...common }
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
      s.showLogs.value = true
      await nextTick()
      logs.value?.focusInput()
      return
    }
    testing.value = true
    executing.value = nodeId
    try {
      // Tests run the saved flow, so save pending edits first.
      if (s.dirty.value) await actions.save()
      const points = [...breakpoints.value].filter((id) => nodes.value.some((node) => node.id === id))
      const result = await call<{ matched: boolean; trace: RunTrace }>('flows.test', { id: flowId.value, ...payload, nodeId, ...(points.length ? { breakpoints: points } : {}) })
      keep(result.trace)
      showTrace(result.trace)
      await nextTick()
      logs.value?.focus(result.trace.id)
      if (!result.matched) message.info(t('flows.testNoMatch'))
    } catch (error) {
      message.error((error as Error).message)
    } finally {
      testing.value = false
      executing.value = undefined
      paused.value = undefined
    }
  }

  /** Opens a test case's run in the logs and draws it on the canvas. */
  function showCaseTrace(trace: RunTrace) {
    if (!runs.value.some((run) => run.id === trace.id)) runs.value = [trace, ...runs.value].slice(0, KEEP)
    showTrace(trace)
    nextTick(() => logs.value?.focus(trace.id))
  }

  /** Cases run the saved flow, so pending edits are saved first. */
  async function saveBeforeTests() {
    if (s.dirty.value) await actions.save()
  }

  const nodeOptions = computed(() => realNodes.value.map((node) => ({ value: node.id, label: s.nodeName(node.id) })))
  function execOptions(nodeId: string) {
    const node = realNodes.value.find((item) => item.id === nodeId)
    const info = node && types.value.get(node.data!.typeId)
    return info ? portsOf(info, node.data!.config).execOut : []
  }

  function clearRuns() {
    runs.value = []
    clearHighlight()
  }

  /** A run picked in the logs: the canvas draws it and keeps it drawn. */
  function showPicked(trace: RunTrace) {
    showTrace(trace, true)
  }

  function selectFromLogs(nodeId: string) {
    if (nodes.value.some((node) => node.id === nodeId)) s.selectNode(nodeId)
  }

  // ---- breakpoints ----

  const breakpointsKey = () => `mushin.flows.breakpoints.${flowId.value}`

  function loadBreakpoints() {
    let saved: string[] = []
    try {
      saved = JSON.parse(localStorage.getItem(breakpointsKey()) ?? '[]')
    } catch {}
    breakpoints.value = new Set(saved.filter((id) => nodes.value.some((node) => node.id === id)))
  }

  function toggleBreakpoint(nodeId: string) {
    const node = realNodes.value.find((item) => item.id === nodeId)
    // Triggers start runs; there is nothing to pause before.
    if (!node || types.value.get(node.data!.typeId)?.kind === 'trigger') return
    const next = new Set(breakpoints.value)
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    breakpoints.value = next
    try {
      localStorage.setItem(breakpointsKey(), JSON.stringify([...next]))
    } catch {}
  }

  const offPaused = on('flows/paused', (pause: FlowPause) => {
    if (pause.flowId !== flowId.value || !testing.value) return
    paused.value = pause
    keep(pause.trace)
    nextTick(() => logs.value?.focus(pause.trace.id))
  })

  /** Answers the paused test run: on to the next breakpoint, one node further, or stop. */
  async function debug(action: 'continue' | 'step' | 'stop') {
    const pause = paused.value
    if (!pause) return
    paused.value = undefined
    try {
      await call('flows.debug', { runId: pause.runId, action })
    } catch (error) {
      message.error((error as Error).message)
    }
  }

  onBeforeUnmount(() => {
    offRun()
    offStep()
    offActivity()
    offPaused()
    window.clearInterval(clock)
    window.clearTimeout(clearTimer)
  })

  return {
    showTrace, stepOf, lastStep, openRun, closeRun, stopViewing, viewingBot, now, liveRuns,
    test, quickTests, schedules, runTest, showCaseTrace, saveBeforeTests, nodeOptions, execOptions, clearRuns, showPicked, selectFromLogs,
    loadBreakpoints, toggleBreakpoint, debug,
  }
}
