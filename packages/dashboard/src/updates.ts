/**
 * Updates of Mushin.js and its plugins, shared by the sidebar, the Plugins page, the settings and the overlay shown
 * while the app restarts. The Updates plugin (plugin-market) does the work; without it there are none.
 */
import { computed, reactive } from 'vue'
import { call } from './api'

export interface PluginUpdateInfo {
  package: string
  current: string
  available?: string
  compatible: boolean
  requires?: string
  error?: string
}

export interface UpdatesInfo {
  checkedAt: number
  mode: 'app' | 'development'
  registry?: string
  mushin?: { current: string; available?: string; channel: 'latest' | 'next'; packages: string[]; notesUrl: string; notes?: string }
  plugins: PluginUpdateInfo[]
  error?: string
  /** The running version. */
  version: string
  /** Started by `mushin start`, so it can restart and update itself. */
  supervised: boolean
  channel: 'auto' | 'latest' | 'next'
}

export interface UpgradeResultInfo {
  ok: boolean
  kind?: 'update' | 'install' | 'uninstall'
  remove?: string[]
  from: string
  to?: string
  version?: string
  packages: string[]
  error?: string
  log?: string
  time: number
  seen?: boolean
}

/** A restart or update in progress, from the moment it was asked for. */
export type ChangeKind = 'update' | 'restart' | 'install' | 'uninstall'

interface Pending {
  kind: ChangeKind
  time: number
  to?: string
  packages?: string[]
}

export const updates = reactive({
  info: undefined as UpdatesInfo | undefined,
  /** The Updates plugin answered, so updates can be shown at all. */
  available: false,
  checking: false,
  pending: undefined as Pending | undefined,
  /** What to show when the app is back, or an earlier result not seen yet. */
  result: undefined as { kind: ChangeKind; value?: UpgradeResultInfo } | undefined,
})

/** How many updates there are: Mushin.js counts once, each plugin once. */
export const updateCount = computed(() => {
  const info = updates.info
  if (!info || info.mode !== 'app') return 0
  return (info.mushin?.available ? 1 : 0) + info.plugins.filter((plugin) => plugin.available).length
})

export const pluginUpdate = (pkg: string) => updates.info?.plugins.find((plugin) => plugin.package === pkg)

export async function loadUpdates(refresh = false) {
  updates.checking = refresh
  try {
    updates.info = await call<UpdatesInfo>('plugins.updates', { refresh })
    updates.available = true
  } catch {
    updates.available = false
  } finally {
    updates.checking = false
  }
}

let loaded = false
/** Loads once per page load, and shows a result the app left from an update that finished while nobody looked. */
export function initUpdates() {
  if (loaded) return
  loaded = true
  void loadUpdates()
  call<{ result: UpgradeResultInfo | null }>('system.updateResult')
    .then(({ result }) => {
      if (result && !result.seen && !updates.pending) updates.result = { kind: result.kind ?? 'update', value: result }
    })
    .catch(() => {})
}

export async function applyUpdates(packages: string[]) {
  const started = await call<{ time: number; to: string; packages: string[] }>('plugins.applyUpdates', { packages })
  updates.result = undefined
  updates.pending = { kind: 'update', time: started.time, to: started.to, packages: started.packages }
  void waitForApp()
}

export async function restartApp() {
  const started = await call<{ time: number }>('system.restart')
  updates.result = undefined
  updates.pending = { kind: 'restart', time: started.time }
  void waitForApp()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Asks the app every two seconds until it is back: for an update, until it reports a result of this update (the
 * old app answers with an older one until it stops); for a restart, until it started after the request.
 */
export async function waitForApp() {
  const pending = updates.pending
  if (!pending) return
  const deadline = Date.now() + 15 * 60_000
  await sleep(1500)
  while (updates.pending === pending && Date.now() < deadline) {
    try {
      const answer = await call<{ result: UpgradeResultInfo | null; startedAt: number }>('system.updateResult')
      if (pending.kind === 'restart' && answer.startedAt > pending.time) break
      if (pending.kind !== 'restart' && answer.result && answer.result.time >= pending.time && answer.startedAt > pending.time) {
        updates.result = { kind: pending.kind, value: answer.result }
        break
      }
    } catch {}
    await sleep(2000)
  }
  if (updates.pending !== pending) return
  // A restart is done when the app is back; an update that never reported back says so.
  if (pending.kind === 'restart' || !updates.result) updates.result = { kind: pending.kind }
  updates.pending = undefined
}

/** Closes the result, and marks it seen so it does not show again. */
export function dismissResult() {
  updates.result = undefined
  call('system.updateResult', { seen: true }).catch(() => {})
  void loadUpdates()
}
