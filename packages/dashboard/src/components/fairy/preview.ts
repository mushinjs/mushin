import { call } from '../../api'

/** A glance at a conversation, as `fairy.preview` gives it. */
export interface SessionPreview {
  id: string
  title: string
  role?: string
  running: boolean
  updatedAt: number
  total: number
  messages: { role: 'user' | 'assistant'; text: string; at: number; refs?: string[] }[]
  steps: { action: string; state: 'running' | 'ok' | 'error' }[]
  waiting?: { action: string }
}

/** The last look at each conversation, shown at once while a fresh one loads. */
const seen = new Map<string, SessionPreview>()

export const cachedPreview = (id: string) => seen.get(id)

export async function loadPreview(id: string) {
  const preview = await call<SessionPreview>('fairy.preview', { id, count: 4 })
  seen.set(id, preview)
  return preview
}

/** "just now", "5 min", "3 h", "2 d", with the workspace's words. */
export function relativeTime(ts: number, t: (key: string, values?: Record<string, unknown>) => string) {
  const minutes = Math.round((Date.now() - ts) / 60_000)
  if (minutes < 1) return t('workspace.justNow')
  if (minutes < 60) return t('workspace.minutesAgo', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('workspace.hoursAgo', { n: hours })
  return t('workspace.daysAgo', { n: Math.round(hours / 24) })
}
