/**
 * Where the Agent sits: docked on the right at a width you drag, or floating over the page where
 * you put it. Remembered in this browser.
 */
import { reactive, watch } from 'vue'

export type DockMode = 'docked' | 'floating'

export interface DockLayout {
  mode: DockMode
  width: number
  float: { x: number; y: number; w: number; h: number }
}

const KEY = 'mushin.agent.dock'
export const DOCK_WIDTH = 400
export const MIN_WIDTH = 320
export const MIN_HEIGHT = 360

function defaults(): DockLayout {
  const w = DOCK_WIDTH
  const h = Math.max(MIN_HEIGHT, Math.min(640, window.innerHeight - 120))
  return { mode: 'docked', width: DOCK_WIDTH, float: { x: Math.max(16, window.innerWidth - w - 24), y: 72, w, h } }
}

function read(): DockLayout {
  const base = defaults()
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!saved || typeof saved !== 'object') return base
    return {
      mode: saved.mode === 'floating' ? 'floating' : 'docked',
      width: Number(saved.width) || base.width,
      float: { ...base.float, ...(saved.float ?? {}) },
    }
  } catch {
    return base
  }
}

export const dockLayout = reactive<DockLayout>(read())

watch(dockLayout, (value) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(value))
  } catch {}
}, { deep: true })

/** The widest the docked Agent may be: it never takes more than half the window. */
export const maxDockWidth = () => Math.max(MIN_WIDTH, Math.min(720, Math.round(window.innerWidth * 0.5)))
export const clampWidth = (width: number) => Math.round(Math.min(maxDockWidth(), Math.max(MIN_WIDTH, width)))

/** Keeps the floating window inside the browser window, at least partly on screen. */
export function clampFloat(float = dockLayout.float) {
  const w = Math.min(Math.max(MIN_WIDTH, float.w), window.innerWidth - 16)
  const h = Math.min(Math.max(MIN_HEIGHT, float.h), window.innerHeight - 16)
  const x = Math.min(Math.max(8, float.x), window.innerWidth - w - 8)
  const y = Math.min(Math.max(8, float.y), window.innerHeight - h - 8)
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}
