import type { AppPlugin, CatalogEntry, DependencyState, PluginDependencies, PluginProvides, PluginStatus, ProjectChatPlugin } from '../types'
import type { GroupKey, ListedPlugin } from './groups'

/** One row of the Plugins page: an app plugin (configured or only installed) or a bot plugin. */
export interface PluginItem extends ListedPlugin {
  /** The entry id, or the package for plugins without an entry. */
  key: string
  description: string
  /** App plugins: the entry, or a stand-in without an id for installed ones never enabled. */
  app?: AppPlugin
  /** The installed package, when it is installed. */
  entry?: CatalogEntry
  deps?: PluginDependencies
  provides?: PluginProvides
  /** Chat plugins: the project switch and the bots it is on for. */
  chat?: ProjectChatPlugin
  status?: PluginStatus
  error?: string
  version?: string
  /** Required plugins that are missing, disabled or the wrong version. */
  missing: DependencyState[]
}

/** The icon of a group, and of plugins in it that have no platform logo. */
export const GROUP_ICONS: Record<GroupKey, string> = {
  bot: 'i-lucide-bot-message-square',
  bundle: 'i-lucide-package',
  adapter: 'i-lucide-plug',
  provider: 'i-lucide-cpu',
  ai: 'i-lucide-sparkles',
  feature: 'i-lucide-blocks',
  core: 'i-lucide-server',
  example: 'i-lucide-flask-conical',
  other: 'i-lucide-puzzle',
}

/** The sections of the details panel, in order. */
export const PANEL_SECTIONS = ['overview', 'usage', 'config', 'deps', 'contents', 'updates'] as const

export type PanelSection = typeof PANEL_SECTIONS[number]
