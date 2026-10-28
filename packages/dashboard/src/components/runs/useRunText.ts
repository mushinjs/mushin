import { useI18n } from 'vue-i18n'
import { useRunsStore } from '../../stores/runs'
import type { BotActivity, FlowRunInfo, FlowRunStatus } from '../../types'
import { localize } from '../../utils'

/** Colors of run states: green going on, orange queued, red failed or stopped, grey done. */
export const runColors: Record<FlowRunStatus, string> = {
  running: '#18a058',
  waiting: '#18a058',
  queued: '#f0a020',
  error: '#d03050',
  stopped: '#d03050',
  ok: '#8c8c8c',
}

/** Words for runs and what bots are doing. */
export function useRunText() {
  const { t, locale } = useI18n()
  const store = useRunsStore()

  const nodeName = (run: FlowRunInfo) => {
    if (!run.node) return ''
    return run.node.label || localize(store.types.get(run.node.type)?.title, locale.value) || run.node.type
  }

  const userName = (run: FlowRunInfo) => run.user?.name || run.user?.id || t('runs.someone')

  /** 空闲 / 正在回复 xxx / 正在执行「流程」· 节点 */
  function activityText(activity: BotActivity) {
    const run = activity.run
    if (!run) return t('runs.idle')
    let text = activity.state === 'replying' ? t('runs.replying', { name: userName(run) }) : t('runs.running', { flow: run.flowName })
    if (activity.state === 'running' && run.node) text = t('runs.atNode', { text, node: nodeName(run) })
    if (run.status === 'queued' || run.status === 'waiting') text = t('runs.withStatus', { text, status: t(`runs.status.${run.status}`) })
    if (activity.count > 1) text = t('runs.others', { text, n: activity.count - 1 })
    return text
  }

  function duration(ms: number) {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (ms < 1000) return `${ms} ms`
    if (seconds < 60) return t('runs.seconds', { n: (ms / 1000).toFixed(seconds < 10 ? 1 : 0) })
    if (seconds < 3600) return t('runs.minutes', { m: Math.floor(seconds / 60), s: seconds % 60 })
    return t('runs.hours', { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) })
  }

  const statusText = (run: FlowRunInfo) => t(`runs.status.${run.status}`)
  function stoppedByText(run: FlowRunInfo) {
    const by = run.stoppedBy
    if (!by) return ''
    if (by.startsWith('flow:')) return t('runs.stoppedByFlow', { flow: by.slice(5) })
    return ['dashboard', 'agent', 'system'].includes(by) ? t(`runs.stoppedBy.${by}`) : by
  }

  return { nodeName, userName, activityText, duration, statusText, stoppedByText }
}
