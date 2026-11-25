/**
 * How the Plugins page groups and orders plugins, and what turning one on or off takes along. Pure functions over
 * a plain description of each plugin, so they are tested without the page.
 */

/** The groups, in the order the page shows them. `bot` holds every bot plugin; the rest follow `mushin.category`. */
export const GROUPS = ['bot', 'bundle', 'adapter', 'provider', 'ai', 'feature', 'core', 'example', 'other'] as const

export type GroupKey = typeof GROUPS[number]

/** Groups folded until the person opens them. */
export const COLLAPSED_BY_DEFAULT: readonly GroupKey[] = ['core', 'example']

/** Groups shown only when something is in them. */
const SHOWN_WHEN_EMPTY: readonly GroupKey[] = ['bot', 'adapter', 'provider', 'ai', 'feature', 'core']

const CATEGORIES = new Set<string>(['adapter', 'provider', 'ai', 'feature', 'core', 'example', 'bundle'])

/** What grouping needs to know about a plugin. */
export interface ListedPlugin {
  package: string
  kind: 'app' | 'bot'
  name: string
  category?: string
  enabled: boolean
  essential?: boolean
  /** Failed, waiting on a dependency, or missing one. */
  problem?: boolean
  /** It adds bot adapters, so without a category it goes with the adapters. */
  addsAdapters?: boolean
  /** Packages it cannot run without. */
  requires: string[]
}

export function groupOf(plugin: ListedPlugin): GroupKey {
  if (plugin.kind === 'bot') return 'bot'
  if (plugin.category && CATEGORIES.has(plugin.category)) return plugin.category as GroupKey
  return plugin.addsAdapters ? 'adapter' : 'other'
}

/** Essential plugins head their group, then the ones with a problem, the enabled ones and the rest; by name within each. */
export function rankOf(plugin: ListedPlugin) {
  if (plugin.essential) return 0
  if (plugin.problem) return 1
  return plugin.enabled ? 2 : 3
}

export function comparePlugins(a: ListedPlugin, b: ListedPlugin, locale?: string) {
  return rankOf(a) - rankOf(b) || a.name.localeCompare(b.name, locale) || a.package.localeCompare(b.package)
}

export interface PluginGroup<T extends ListedPlugin> {
  key: GroupKey
  /** Every plugin in the group, in order. */
  all: T[]
  /** The ones that match the search and filter. */
  shown: T[]
  enabled: number
  problems: number
  open: boolean
}

export interface GroupOptions<T> {
  /** Whether a plugin matches the search and the filter. */
  matches?: (plugin: T) => boolean
  /** A search or filter is on: groups with matches open and the others hide. */
  narrowed?: boolean
  /** Groups the person folded (true) or opened (false); the rest keep their default. */
  collapsed?: Partial<Record<string, boolean>>
  locale?: string
}

/** The groups to show, each sorted, with whether it is open. */
export function groupPlugins<T extends ListedPlugin>(plugins: T[], options: GroupOptions<T> = {}): PluginGroup<T>[] {
  const { matches = () => true, narrowed = false, collapsed = {}, locale } = options
  const groups: PluginGroup<T>[] = []
  for (const key of GROUPS) {
    const all = plugins.filter((plugin) => groupOf(plugin) === key).sort((a, b) => comparePlugins(a, b, locale))
    const shown = all.filter(matches)
    const problems = all.filter((plugin) => plugin.problem).length
    if (narrowed ? !shown.length : !all.length && !SHOWN_WHEN_EMPTY.includes(key)) continue
    const folded = collapsed[key] ?? COLLAPSED_BY_DEFAULT.includes(key)
    groups.push({
      key,
      all,
      shown,
      enabled: all.filter((plugin) => plugin.enabled).length,
      problems,
      // A group with a problem never hides it; a search opens every group it found something in.
      open: narrowed || problems > 0 || !folded,
    })
  }
  return groups
}

/** For each package, the packages it requires and the ones that require it. */
export function relationsOf(plugins: ListedPlugin[]) {
  const map = new Map<string, { requires: Set<string>; dependents: Set<string> }>()
  const at = (pkg: string) => {
    let value = map.get(pkg)
    if (!value) map.set(pkg, (value = { requires: new Set(), dependents: new Set() }))
    return value
  }
  for (const plugin of plugins) {
    for (const dep of plugin.requires) {
      at(plugin.package).requires.add(dep)
      at(dep).dependents.add(plugin.package)
    }
    at(plugin.package)
  }
  return map
}

/**
 * What else changes when a plugin is turned on or off: turning it on turns on the disabled plugins it needs, and
 * theirs; turning it off stops the enabled plugins that need it, and theirs. Packages that are not listed (not
 * installed) are left out, as nothing can turn them on.
 */
export function toggleImpact(pkg: string, plugins: ListedPlugin[], enabling: boolean): string[] {
  const byPackage = new Map(plugins.map((plugin) => [plugin.package, plugin]))
  const relations = relationsOf(plugins)
  const found: string[] = []
  const seen = new Set([pkg])
  const queue = [pkg]
  while (queue.length) {
    const current = queue.shift()!
    const next = enabling ? relations.get(current)?.requires : relations.get(current)?.dependents
    for (const other of next ?? []) {
      if (seen.has(other)) continue
      seen.add(other)
      const plugin = byPackage.get(other)
      // Bot plugins are not turned on along with what they need, and a plugin already in the wanted state stops the walk.
      if (!plugin || plugin.enabled === enabling || (enabling && plugin.kind === 'bot')) continue
      found.push(other)
      queue.push(other)
    }
  }
  return found
}
