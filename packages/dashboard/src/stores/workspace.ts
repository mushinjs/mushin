/**
 * The Fairy workspace's layout: the sessions column on the left, one or two conversations in the middle, and
 * the panel on the right that shows pages, web pages and status. Remembered in this browser.
 */
import { reactive, watch } from 'vue'

/** One tab of the side panel: the status of bots and plugins, commands run on this machine, a dashboard page, or a web page. */
export interface PanelView {
  id: string
  kind: 'status' | 'terminal' | 'page' | 'web'
  path?: string
  url?: string
  title?: string
}

export interface WorkspaceLayout {
  leftOpen: boolean
  rightOpen: boolean
  leftWidth: number
  rightWidth: number
  /** A second conversation beside the first. */
  split: boolean
  /** The first conversation's share of the middle, 0.2 to 0.8. */
  splitRatio: number
  views: PanelView[]
  activeView: string
  /** Groups folded shut in the sessions column; `done` stands for the done conversations. */
  folded: string[]
}

const KEY = 'mushin.fairy.workspace'
export const LEFT_WIDTH = 260
export const RIGHT_WIDTH = 480
export const MIN_SIDE = 200
export const MIN_CENTER = 360

const STATUS: PanelView = { id: 'status', kind: 'status' }

function defaults(): WorkspaceLayout {
  const wide = window.innerWidth >= 1200
  return {
    leftOpen: window.innerWidth >= 800,
    rightOpen: wide,
    leftWidth: LEFT_WIDTH,
    rightWidth: RIGHT_WIDTH,
    split: false,
    splitRatio: 0.5,
    views: [STATUS],
    activeView: STATUS.id,
    folded: ['done'],
  }
}

function read(): WorkspaceLayout {
  const base = defaults()
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!saved || typeof saved !== 'object') return base
    const views = Array.isArray(saved.views) ? saved.views.filter((view: PanelView) => view?.id && ['status', 'terminal', 'page', 'web'].includes(view.kind)) : base.views
    return {
      ...base,
      ...saved,
      views: views.some((view: PanelView) => view.kind === 'status') ? views : [STATUS, ...views],
      folded: Array.isArray(saved.folded) ? saved.folded : base.folded,
    }
  } catch {
    return base
  }
}

let seq = 0

/** A page address without its query and hash. */
const pageOf = (path?: string) => path?.split(/[?#]/)[0]

export const workspace = reactive({
  layout: read(),
  /** The workspace page is open in this tab, so Fairy's pages go to the panel. */
  active: false,
  /** The pane that takes a conversation picked in the sessions column. */
  focused: 'main' as 'main' | 'split',
  /** The dashboard page you came from, where the Console button goes back to. */
  returnTo: '/overview',

  /**
   * Shows a view in the panel and opens the panel. A tab that shows the same thing is reused; for pages, the same
   * page with other query parameters counts, and moves to the new address.
   */
  openView(input: Omit<PanelView, 'id'>): PanelView {
    const layout = this.layout
    let view = layout.views.find((item) => item.kind === input.kind && (input.kind === 'status' || input.kind === 'terminal' || (input.kind === 'page' ? pageOf(item.path) === pageOf(input.path) : item.url === input.url)))
    if (view?.kind === 'page' && input.path) view.path = input.path
    if (!view) {
      view = { ...input, id: `${input.kind}-${Date.now().toString(36)}-${++seq}` }
      layout.views.push(view)
      // Keep the panel to a handful of tabs: the oldest page goes first.
      const closable = layout.views.filter((item) => item.kind !== 'status')
      if (closable.length > 8) layout.views.splice(layout.views.indexOf(closable[0]!), 1)
    } else if (input.title) {
      view.title = input.title
    }
    layout.activeView = view.id
    layout.rightOpen = true
    return view
  },

  closeView(id: string) {
    const layout = this.layout
    const index = layout.views.findIndex((view) => view.id === id)
    if (index < 0 || layout.views[index]!.kind === 'status') return
    layout.views.splice(index, 1)
    if (layout.activeView === id) layout.activeView = (layout.views[index] ?? layout.views[index - 1] ?? STATUS).id
  },

  toggleFold(key: string) {
    const folded = this.layout.folded
    const at = folded.indexOf(key)
    if (at < 0) folded.push(key)
    else folded.splice(at, 1)
  },
})

watch(() => workspace.layout, (value) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(value))
  } catch {}
}, { deep: true })
