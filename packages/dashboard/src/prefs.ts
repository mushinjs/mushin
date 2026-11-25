import { reactive, watch } from 'vue'

/** Pages that Settings → Features can hide from the sidebar. The rest are always there. */
export const OPTIONAL_PAGES = ['flows', 'personas', 'knowledge', 'database', 'plugins', 'logs'] as const

/** Preferences of this browser, set under Settings → Features. */
export interface Prefs {
  /** Open the Fairy panel when the dashboard loads (wide windows only). */
  fairyOpenOnStart: boolean
  /** Sidebar entries the user hid; the pages still open by link. */
  hiddenPages: string[]
  /** The Plugins page: groups folded (true) or opened (false) by hand, the details panel's width and last section, and how settings are edited. */
  pluginGroups: Record<string, boolean>
  pluginPanelWidth: number
  pluginPanelSection: string
  pluginConfigMode: 'form' | 'json'
}

const KEY = 'mushin.prefs'

function read(): Prefs {
  const prefs: Prefs = { fairyOpenOnStart: true, hiddenPages: [], pluginGroups: {}, pluginPanelWidth: 520, pluginPanelSection: 'overview', pluginConfigMode: 'form' }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (typeof saved.fairyOpenOnStart === 'boolean') prefs.fairyOpenOnStart = saved.fairyOpenOnStart
    if (Array.isArray(saved.hiddenPages)) prefs.hiddenPages = saved.hiddenPages.filter((page: unknown) => typeof page === 'string')
    if (saved.pluginGroups && typeof saved.pluginGroups === 'object') {
      prefs.pluginGroups = Object.fromEntries(Object.entries(saved.pluginGroups).filter(([, value]) => typeof value === 'boolean')) as Record<string, boolean>
    }
    if (typeof saved.pluginPanelWidth === 'number' && saved.pluginPanelWidth >= 360) prefs.pluginPanelWidth = saved.pluginPanelWidth
    if (typeof saved.pluginPanelSection === 'string') prefs.pluginPanelSection = saved.pluginPanelSection
    if (saved.pluginConfigMode === 'form' || saved.pluginConfigMode === 'json') prefs.pluginConfigMode = saved.pluginConfigMode
  } catch {}
  return prefs
}

export const prefs = reactive<Prefs>(read())

watch(prefs, (value) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(value))
  } catch {}
}, { deep: true })
