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

/** How long a look at a resting conversation stands before resting on it again asks anew. */
export const FRESH_FOR = 15_000
/** Most conversations whose last look is kept; the longest unseen goes first. */
export const KEEP = 50

/** The last look at each conversation, shown at once while a fresh one loads, oldest first. */
const seen = new Map<string, { preview: SessionPreview; at: number }>()
/** Looks on their way, so two cards on one conversation share a request. */
const loading = new Map<string, Promise<SessionPreview>>()

function remember(id: string, preview: SessionPreview, at: number) {
  seen.delete(id)
  seen.set(id, { preview, at })
  while (seen.size > KEEP) seen.delete(seen.keys().next().value!)
}

export const cachedPreview = (id: string) => seen.get(id)?.preview

/**
 * A look at a conversation. One that rests is not asked for again within `FRESH_FOR`, unless it has changed since
 * (`updatedAt`, as a list knows it) or `fresh` is set; one at work is always asked for.
 */
export function loadPreview(id: string, options: { fresh?: boolean; updatedAt?: number } = {}): Promise<SessionPreview> {
  const kept = seen.get(id)
  const stale = !kept || options.fresh || kept.preview.running || Date.now() - kept.at >= FRESH_FOR || (options.updatedAt !== undefined && options.updatedAt !== kept.preview.updatedAt)
  if (!stale) {
    remember(id, kept.preview, kept.at)
    return Promise.resolve(kept.preview)
  }
  const going = loading.get(id)
  if (going) return going
  const request = call<SessionPreview>('fairy.preview', { id, count: 4 })
    .then((preview) => {
      remember(id, preview, Date.now())
      return preview
    })
    .finally(() => loading.delete(id))
  loading.set(id, request)
  return request
}

/** Forgets every look, for tests. */
export function forgetPreviews() {
  seen.clear()
  loading.clear()
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
