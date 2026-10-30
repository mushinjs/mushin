import { reactive, watch } from 'vue'

/** Pages that Settings → Features can hide from the sidebar. The rest are always there. */
export const OPTIONAL_PAGES = ['flows', 'personas', 'knowledge', 'database', 'plugins', 'logs'] as const

/** Preferences of this browser, set under Settings → Features. */
export interface Prefs {
  /** Open the Agent panel when the dashboard loads (wide windows only). */
  agentOpenOnStart: boolean
  /** Sidebar entries the user hid; the pages still open by link. */
  hiddenPages: string[]
}

const KEY = 'mushin.prefs'

function read(): Prefs {
  const prefs: Prefs = { agentOpenOnStart: true, hiddenPages: [] }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (typeof saved.agentOpenOnStart === 'boolean') prefs.agentOpenOnStart = saved.agentOpenOnStart
    if (Array.isArray(saved.hiddenPages)) prefs.hiddenPages = saved.hiddenPages.filter((page: unknown) => typeof page === 'string')
  } catch {}
  return prefs
}

export const prefs = reactive<Prefs>(read())

watch(prefs, (value) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(value))
  } catch {}
}, { deep: true })
