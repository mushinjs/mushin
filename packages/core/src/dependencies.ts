import { type CatalogEntry, dependencyPlugins, MUSHIN_VERSION, type PluginManifest } from './manifest'
import { satisfies } from './semver'

/**
 * How plugins depend on each other, from the `requires` and `optional` fields of their manifests.
 * These are pure functions over the catalog and the configured entries, so the manager, the
 * dashboard's API and tests share them.
 */

/** Why a dependency does not count as met. */
export type DependencyProblem = 'not-installed' | 'version' | 'disabled' | 'not-app'

export interface DependencyState {
  package: string
  range: string
  optional: boolean
  installed: boolean
  version?: string
  kind?: 'app' | 'bot'
  /** For app plugins: an entry for it is enabled in mushin.config.json. */
  enabled: boolean
  /** Id of its entry in mushin.config.json, when it has one. */
  entry?: string
  problem?: DependencyProblem
}

export interface DependentState {
  package: string
  kind: 'app' | 'bot'
  optional: boolean
  /** App plugins: an entry for it is enabled. Bot plugins: always false here; they are enabled per bot. */
  enabled: boolean
  entry?: string
}

export interface DependencyReport {
  package: string
  /** The Mushin.js version range the plugin needs, if it states one. */
  mushin?: { range: string; version: string; ok: boolean }
  requires: DependencyState[]
  optional: DependencyState[]
  /** Installed plugins that list this one. */
  dependents: DependentState[]
}

export interface EntryLike {
  id: string
  package: string
  enabled?: boolean
}

export interface DependencyGraph {
  catalog: CatalogEntry[]
  entries: EntryLike[]
  /** Manifests for packages that do not ship one, such as the HTTP server. */
  known?: (name: string) => PluginManifest | undefined
}

function manifestOf(graph: DependencyGraph, name: string) {
  return graph.catalog.find((entry) => entry.package === name)?.manifest ?? graph.known?.(name)
}

function entryOf(graph: DependencyGraph, name: string) {
  return graph.entries.find((entry) => entry.package === name && entry.enabled !== false)
    ?? graph.entries.find((entry) => entry.package === name)
}

function stateOf(graph: DependencyGraph, name: string, range: string, optional: boolean): DependencyState {
  const catalog = graph.catalog.find((entry) => entry.package === name)
  const known = graph.known?.(name)
  const installed = !!catalog || !!known
  const kind = catalog?.manifest.kind ?? known?.kind
  const entry = entryOf(graph, name)
  const enabled = !!entry && entry.enabled !== false
  const version = catalog?.version
  let problem: DependencyProblem | undefined
  if (!installed) problem = 'not-installed'
  else if (catalog && !satisfies(catalog.version, range)) problem = 'version'
  else if (kind === 'bot') problem = 'not-app'
  else if (!enabled) problem = 'disabled'
  return { package: name, range, optional, installed, ...(version ? { version } : {}), ...(kind ? { kind } : {}), enabled, ...(entry ? { entry: entry.id } : {}), ...(problem ? { problem } : {}) }
}

/** Dependencies, dependents and the Mushin.js version check of one package. */
export function dependencyReport(graph: DependencyGraph, name: string): DependencyReport {
  const manifest = manifestOf(graph, name)
  const range = manifest?.requires?.mushin
  return {
    package: name,
    ...(typeof range === 'string' ? { mushin: { range, version: MUSHIN_VERSION, ok: satisfies(MUSHIN_VERSION, range) } } : {}),
    requires: dependencyPlugins(manifest, 'requires').map(([dep, range]) => stateOf(graph, dep, range, false)),
    optional: dependencyPlugins(manifest, 'optional').map(([dep, range]) => stateOf(graph, dep, range, true)),
    dependents: graph.catalog.flatMap((entry): DependentState[] => {
      const required = dependencyPlugins(entry.manifest, 'requires').some(([dep]) => dep === name)
      const optional = !required && dependencyPlugins(entry.manifest, 'optional').some(([dep]) => dep === name)
      if (!required && !optional) return []
      const own = entry.manifest.kind === 'app' ? entryOf(graph, entry.package) : undefined
      return [{ package: entry.package, kind: entry.manifest.kind, optional, enabled: !!own && own.enabled !== false, ...(own ? { entry: own.id } : {}) }]
    }),
  }
}

/** Required dependencies that stop a package from running, as states. Bot plugins only need theirs installed and enabled. */
export function unmet(graph: DependencyGraph, name: string) {
  return dependencyReport(graph, name).requires.filter((dep) => dep.problem && dep.problem !== 'not-app')
}

export interface EnablePlan {
  /** Installed app plugins to enable first, dependencies before the plugins that need them. */
  enable: string[]
  /** Required packages that are not installed, or whose version does not fit. */
  blocked: DependencyState[]
  /** The Mushin.js version does not fit a plugin in the chain. */
  mushin: { package: string; range: string; version: string }[]
}

/** What enabling a package takes: the disabled app plugins it needs, transitively. */
export function planEnable(graph: DependencyGraph, name: string): EnablePlan {
  const enable: string[] = []
  const blocked: DependencyState[] = []
  const mushin: EnablePlan['mushin'] = []
  const seen = new Set<string>()
  const visit = (pkg: string) => {
    if (seen.has(pkg)) return
    seen.add(pkg)
    const report = dependencyReport(graph, pkg)
    if (report.mushin && !report.mushin.ok) mushin.push({ package: pkg, range: report.mushin.range, version: report.mushin.version })
    for (const dep of report.requires) {
      if (dep.problem === 'not-installed' || dep.problem === 'version') {
        blocked.push(dep)
        continue
      }
      if (dep.kind !== 'app') continue
      visit(dep.package)
      if (dep.problem === 'disabled' && !enable.includes(dep.package)) enable.push(dep.package)
    }
  }
  visit(name)
  return { enable: enable.filter((pkg) => pkg !== name), blocked, mushin }
}

export interface DisablePlan {
  /** Enabled app plugin entries that need this one and stop with it, those further away first. */
  disable: { id: string; package: string }[]
  /** Bot plugins that need it; they stop working on every bot. */
  botPlugins: string[]
  /** Plugins that keep running with fewer features. */
  degraded: string[]
}

/** What disabling a package takes: the enabled app plugins that require it, transitively. */
export function planDisable(graph: DependencyGraph, name: string): DisablePlan {
  const disable: DisablePlan['disable'] = []
  const botPlugins = new Set<string>()
  const degraded = new Set<string>()
  const seen = new Set<string>([name])
  const visit = (pkg: string) => {
    for (const dependent of dependencyReport(graph, pkg).dependents) {
      if (dependent.optional) {
        if (dependent.kind === 'bot' || dependent.enabled) degraded.add(dependent.package)
        continue
      }
      if (dependent.kind === 'bot') {
        botPlugins.add(dependent.package)
        continue
      }
      if (!dependent.enabled || seen.has(dependent.package)) continue
      seen.add(dependent.package)
      visit(dependent.package)
      disable.push({ id: dependent.entry!, package: dependent.package })
    }
  }
  visit(name)
  for (const item of disable) degraded.delete(item.package)
  return { disable, botPlugins: [...botPlugins], degraded: [...degraded] }
}

/**
 * Orders entries so each comes after the entries it requires. Entries in a cycle are left out and
 * reported with the cycle, e.g. `a → b → a`.
 */
export function loadOrder<E extends EntryLike>(graph: DependencyGraph, entries: E[]): { order: E[]; cycles: { entries: E[]; chain: string[] }[] } {
  const byPackage = new Map(entries.map((entry) => [entry.package, entry]))
  const needs = (entry: E) => dependencyPlugins(manifestOf(graph, entry.package), 'requires')
    .map(([dep]) => byPackage.get(dep))
    .filter((dep): dep is E => !!dep && dep !== entry)
  const order: E[] = []
  const state = new Map<E, 'visiting' | 'done' | 'cycle'>()
  const cycles: { entries: E[]; chain: string[] }[] = []
  const stack: E[] = []
  const visit = (entry: E): boolean => {
    const current = state.get(entry)
    if (current === 'done') return true
    if (current === 'cycle') return false
    if (current === 'visiting') {
      const loop = stack.slice(stack.indexOf(entry))
      for (const item of loop) state.set(item, 'cycle')
      cycles.push({ entries: loop, chain: [...loop, entry].map((item) => item.package) })
      return false
    }
    state.set(entry, 'visiting')
    stack.push(entry)
    // A plugin that needs one in a cycle still loads; it waits, and its status names what is missing.
    for (const dep of needs(entry)) visit(dep)
    stack.pop()
    if (state.get(entry) === 'cycle') return false
    state.set(entry, 'done')
    order.push(entry)
    return true
  }
  for (const entry of entries) visit(entry)
  return { order, cycles }
}

/** Service names a plugin injects, from `inject` as an array or as `{ name: … }`. */
export function injectedServices(plugin: unknown): { required: string[]; optional: string[] } {
  const inject = (plugin as { inject?: unknown } | undefined)?.inject
  if (!inject) return { required: [], optional: [] }
  if (Array.isArray(inject)) return { required: inject.map(String), optional: [] }
  if (typeof inject !== 'object') return { required: [], optional: [] }
  const required: string[] = []
  const optional: string[] = []
  for (const [name, value] of Object.entries(inject as Record<string, any>)) {
    if (name === 'required' && Array.isArray(value)) required.push(...value.map(String))
    else if (name === 'optional' && Array.isArray(value)) optional.push(...value.map(String))
    else if (value && typeof value === 'object' && value.required === false) optional.push(name)
    else required.push(name)
  }
  return { required, optional }
}

/** The package that provides a service, per the catalog's `provides` fields. */
export function providerOf(graph: DependencyGraph, service: string) {
  return graph.catalog.find((entry) => entry.manifest.provides?.includes(service))?.package
    ?? graph.entries.map((entry) => entry.package).find((pkg) => graph.known?.(pkg)?.provides?.includes(service))
}

/**
 * Services a plugin injects that its manifest does not explain: the package providing the service
 * is in neither `requires` nor `optional`. Helps plugin authors keep the two in step.
 */
export function undeclaredServices(graph: DependencyGraph, name: string, plugin: unknown) {
  const manifest = manifestOf(graph, name)
  const declared = new Set([...dependencyPlugins(manifest, 'requires'), ...dependencyPlugins(manifest, 'optional')].map(([dep]) => dep))
  const { required, optional } = injectedServices(plugin)
  return [...new Set([...required, ...optional])].flatMap((service) => {
    const provider = providerOf(graph, service)
    if (!provider || provider === name || declared.has(provider)) return []
    return [{ service, provider }]
  })
}
