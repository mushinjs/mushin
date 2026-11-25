import { useToast } from '@mushinjs/ui'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { on } from '../api'
import { i18n } from '../i18n'
import type { FairyEvent } from '../types'
import { useFairyPane, useFairyStore } from './fairy'
import { workspace } from './workspace'

/** A conversation Fairy is working on, and what it waits on you for, if anything. */
export interface Activity {
  session: string
  /** An approval or an answer it, or a helper it started, waits for. */
  waiting?: 'confirm' | 'ask'
  /** The tool it called last. */
  action?: string
  since: number
}

const t = (key: string, values: Record<string, unknown> = {}) => i18n.global.t(key, values)

/**
 * What Fairy is busy with across all conversations, for the Fairy button and the session lists. A conversation
 * you are not looking at tells you with a toast when it finishes, fails, or needs an approval or an answer; the
 * toast's button opens it.
 */
export const useFairyActivityStore = defineStore('fairyActivity', () => {
  const fairy = useFairyStore()
  const toast = useToast()
  const items = ref<Record<string, Activity>>({})
  /** Approvals and questions open per conversation, by `<session>:<call>` (a helper's count for its parent). */
  const pending = new Map<string, Map<string, 'confirm' | 'ask'>>()

  const list = computed(() => Object.values(items.value).sort((a, b) => Number(!!b.waiting) - Number(!!a.waiting) || a.since - b.since))
  const waitingCount = computed(() => list.value.filter((item) => item.waiting).length)

  const of = (session: string): Activity | undefined => items.value[session]
  const titleOf = (session: string) => fairy.sessions.find((item) => item.id === session)?.title || t('fairy.untitled')

  /** The conversation is on screen here: in the open dock, or in a pane of the workspace. */
  function visible(session: string) {
    if (document.visibilityState !== 'visible') return false
    if (workspace.active) return fairy.current === session || (workspace.layout.split && useFairyPane('split').current === session)
    return fairy.open && fairy.current === session
  }

  /** Brings a conversation up: in the workspace's main pane there, in the dock elsewhere. */
  function show(session: string) {
    if (workspace.active) {
      if (workspace.layout.split && useFairyPane('split').current === session) return
    } else {
      fairy.open = true
    }
    if (fairy.current !== session) fairy.load(session).catch(() => {})
  }

  function touch(session: string) {
    return (items.value[session] ??= { session, since: Date.now() })
  }

  function settle(session: string) {
    const entry = items.value[session]
    if (!entry) return
    const kinds = [...(pending.get(session)?.values() ?? [])]
    const waiting = kinds.includes('confirm') ? 'confirm' : kinds.includes('ask') ? 'ask' : undefined
    const before = entry.waiting
    if (waiting) entry.waiting = waiting
    else delete entry.waiting
    if (waiting && waiting !== before && !visible(session)) {
      const key = waiting === 'confirm' ? 'fairyActivity.toastConfirm' : 'fairyActivity.toastAsk'
      toast.warning(t(key, { title: titleOf(session) }), { duration: 8000, closable: true, action: { label: t('fairyActivity.view'), onClick: () => show(session) } })
    }
  }

  function finish(event: Extract<FairyEvent, { type: 'done' | 'error' }>) {
    const session = event.session
    delete items.value[session]
    pending.delete(session)
    if (visible(session) || document.visibilityState !== 'visible') return
    if (event.type === 'error' && event.error === 'Stopped') return
    const title = titleOf(session)
    const action = { label: t('fairyActivity.view'), onClick: () => show(session) }
    if (event.type === 'done') toast.success(t('fairyActivity.toastDone', { title }), { duration: 6000, closable: true, action })
    else if (event.code === 'max_steps') toast.warning(t('fairyActivity.toastLimit', { title }), { duration: 8000, closable: true, action })
    else toast.error(t('fairyActivity.toastError', { title, error: event.error.split('\n')[0]!.slice(0, 80) }), { duration: 8000, closable: true, action })
  }

  function handle(event: FairyEvent) {
    // A helper's events count for the conversation that started it.
    const top = event.parent ?? event.session
    const key = 'id' in event ? `${event.session}:${event.id}` : ''
    switch (event.type) {
      case 'start':
        if (event.parent) break
        touch(top)
        // A new conversation: the list brings its title.
        if (!fairy.sessions.some((item) => item.id === top)) fairy.refreshSessions().catch(() => {})
        break
      case 'tool-call':
        touch(top).action = event.action
        if (event.action === 'ui.ask') {
          const open = pending.get(top) ?? new Map()
          pending.set(top, open.set(key, 'ask'))
          settle(top)
        }
        break
      case 'confirm': {
        touch(top)
        const open = pending.get(top) ?? new Map()
        pending.set(top, open.set(key, 'confirm'))
        settle(top)
        break
      }
      case 'tool-result':
        pending.get(top)?.delete(key)
        settle(top)
        break
      case 'done':
      case 'error':
        if (!event.parent) finish(event)
        else {
          // A helper that ended waits on nothing any more.
          const open = pending.get(top)
          for (const id of [...open?.keys() ?? []]) if (id.startsWith(`${event.session}:`)) open!.delete(id)
          settle(top)
        }
        break
    }
  }

  // The conversation list knows what runs and waits when this page did not see it start, e.g. after a reload.
  watch(() => fairy.sessions, (sessions) => {
    for (const session of sessions) {
      const entry = items.value[session.id]
      if (session.running && !entry) items.value[session.id] = { session: session.id, since: session.updatedAt, ...(session.waiting ? { waiting: session.waiting } : {}) }
      else if (session.running && entry && session.waiting && !entry.waiting) entry.waiting = session.waiting
      else if (!session.running && entry && Date.now() - entry.since > 5000) {
        delete items.value[session.id]
        pending.delete(session.id)
      }
    }
  })

  let bound = false
  function bind() {
    if (bound) return
    bound = true
    on('fairy/event', handle)
  }

  return { items, list, waitingCount, of, titleOf, visible, show, bind }
})
