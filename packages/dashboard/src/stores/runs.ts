import { defineStore } from 'pinia'
import { ref } from 'vue'
import { call, on } from '../api'
import type { BotActivity, FlowRunInfo, FlowRunStatus, NodeTypeInfo } from '../types'

export const LIVE_STATUSES: FlowRunStatus[] = ['queued', 'running', 'waiting']
export const isLive = (run: FlowRunInfo) => LIVE_STATUSES.includes(run.status)

/** Runs going on across bots, kept fresh by `flows/activity`; what each bot is doing comes from them. */
export const useRunsStore = defineStore('runs', () => {
  const live = ref(new Map<string, FlowRunInfo>())
  /** Node type titles, to name the node a run is on. */
  const types = ref(new Map<string, NodeTypeInfo>())
  const listeners = new Set<(run: FlowRunInfo) => void>()

  async function refresh() {
    const [activity, typeList] = await Promise.all([
      call<{ runs: FlowRunInfo[] }>('flows.activity', {}),
      types.value.size ? Promise.resolve(undefined) : call<NodeTypeInfo[]>('flows.nodeTypes'),
    ])
    live.value = new Map(activity.runs.map((run) => [run.id, run]))
    if (typeList) types.value = new Map(typeList.map((type) => [type.type, type]))
  }

  /** What a bot is doing: the newest run that is not queued, else the newest queued one. */
  function activityOf(botId: string): BotActivity {
    const runs = [...live.value.values()].filter((run) => run.botId === botId).sort((a, b) => b.startedAt - a.startedAt)
    const run = runs.find((item) => item.status !== 'queued') ?? runs[0]
    // A message's run is replying, unless it queues or works at a long node such as a command.
    const state = !run ? 'idle' : run.source === 'message' && run.status !== 'queued' && !run.node?.long ? 'replying' : 'running'
    return { botId, state, ...(run ? { run } : {}), count: runs.length }
  }

  /** Hears every change to a run, live or just finished. Returns the function that stops listening. */
  function subscribe(listener: (run: FlowRunInfo) => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  let bound = false
  function bind() {
    if (bound) return
    bound = true
    on('flows/activity', (run: FlowRunInfo) => {
      const next = new Map(live.value)
      if (isLive(run)) next.set(run.id, run)
      else next.delete(run.id)
      live.value = next
      for (const listener of listeners) listener(run)
    })
    on('connected', () => refresh().catch(() => {}))
    refresh().catch(() => {})
  }

  return { live, types, refresh, activityOf, subscribe, bind }
})
