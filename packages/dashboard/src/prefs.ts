import { reactive, watch } from 'vue'

/** Pages that Settings → Features can hide from the sidebar. The rest are always there. */
export const OPTIONAL_PAGES = ['flows', 'personas', 'knowledge', 'database', 'plugins', 'logs'] as const

/** Preferences of this browser, set under Settings → Features. */
export interface Prefs {
  /** Open the Fairy panel when the dashboard loads (wide windows only). */
  fairyOpenOnStart: boolean
  /**
   * Let Fairy open pages and scroll to what it points at by itself. Off, a page Fairy offers is a card in
   * the chat, unless you asked to be taken there.
   */
  fairyOpensPages: boolean
  /** Sidebar entries the user hid; the pages still open by link. */
  hiddenPages: string[]
  /** The Plugins page: groups folded (true) or opened (false) by hand, the details panel's width and last section, and how settings are edited. */
  pluginGroups: Record<string, boolean>
  pluginPanelWidth: number
  pluginPanelSection: string
  pluginConfigMode: 'form' | 'json'
  /** Log views fold repeated lines into one row with a count. */
  logFold: boolean
  /** The Logs page shows Mushin.js's debug lines too. */
  logDebug: boolean
}

const KEY = 'mushin.prefs'

function read(): Prefs {
  const prefs: Prefs = { fairyOpenOnStart: true, fairyOpensPages: false, hiddenPages: [], pluginGroups: {}, pluginPanelWidth: 520, pluginPanelSection: 'overview', pluginConfigMode: 'form', logFold: true, logDebug: false }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (typeof saved.fairyOpenOnStart === 'boolean') prefs.fairyOpenOnStart = saved.fairyOpenOnStart
    if (typeof saved.fairyOpensPages === 'boolean') prefs.fairyOpensPages = saved.fairyOpensPages
    if (typeof saved.logFold === 'boolean') prefs.logFold = saved.logFold
    if (typeof saved.logDebug === 'boolean') prefs.logDebug = saved.logDebug
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
