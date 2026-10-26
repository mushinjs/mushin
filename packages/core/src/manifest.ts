import { readFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validRange } from './semver'

export type LocalizedText = string | Record<string, string>

/** The `mushin` field in a plugin's package.json. */
export interface PluginManifest {
  kind: 'app' | 'bot'
  displayName?: LocalizedText
  description?: LocalizedText
  /** Essential app plugins cannot be disabled from the dashboard or by the Agent. */
  essential?: boolean
  platforms?: string[]
  category?: string
  /** Service names this plugin provides, such as `flows`; maps `inject` names to packages. */
  provides?: string[]
  /** Needed to run: without them the plugin cannot be enabled. */
  requires?: DependencySpec
  /** Used when present: without them the plugin runs, and the features that need them say so. */
  optional?: DependencySpec
  /** Flow node types this plugin adds, such as `logic.permission` or `onebot.*`, so the editor can say which plugin to enable for an unknown node. */
  nodes?: string[]
}

export interface DependencySpec {
  /** A version range of Mushin.js, such as `>=0.2.0`. */
  mushin?: string
  /** Package name → version range, such as `{ "@mushin/plugin-bots": "*" }`. */
  plugins?: Record<string, string>
}

/** The running Mushin.js version: the version of `@mushin/core`. */
export const MUSHIN_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Problems with the dependency fields of a manifest, in words a plugin author can act on. */
export function manifestProblems(manifest: PluginManifest): string[] {
  const problems: string[] = []
  if (manifest.provides !== undefined && (!Array.isArray(manifest.provides) || manifest.provides.some((item) => typeof item !== 'string'))) {
    problems.push('"provides" should be a list of service names')
  }
  for (const key of ['requires', 'optional'] as const) {
    const spec = manifest[key]
    if (spec === undefined) continue
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      problems.push(`"${key}" should be an object with "mushin" and "plugins"`)
      continue
    }
    if (spec.mushin !== undefined && (typeof spec.mushin !== 'string' || !validRange(spec.mushin))) {
      problems.push(`"${key}.mushin" is not a version range: ${JSON.stringify(spec.mushin)}`)
    }
    if (spec.plugins !== undefined) {
      if (!spec.plugins || typeof spec.plugins !== 'object' || Array.isArray(spec.plugins)) {
        problems.push(`"${key}.plugins" should map package names to version ranges`)
        continue
      }
      for (const [name, range] of Object.entries(spec.plugins)) {
        if (typeof range !== 'string' || !validRange(range)) problems.push(`"${key}.plugins.${name}" is not a version range: ${JSON.stringify(range)}`)
      }
    }
  }
  return problems
}

/** Package name → range of the plugins a manifest lists under `requires` or `optional`. */
export function dependencyPlugins(manifest: PluginManifest | undefined, key: 'requires' | 'optional'): [string, string][] {
  const plugins = manifest?.[key]?.plugins
  if (!plugins || typeof plugins !== 'object') return []
  return Object.entries(plugins).filter(([, range]) => typeof range === 'string')
}

export interface CatalogEntry {
  package: string
  version: string
  /** Absolute path of the package directory. */
  path: string
  local: boolean
  manifest: PluginManifest
}

interface PackageJson {
  name?: string
  version?: string
  description?: string
  main?: string
  module?: string
  exports?: any
  mushin?: PluginManifest
}

export async function readPackageJson(dir: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** Resolves the file a package's `import` entry points to. */
export function resolvePackageEntry(dir: string, pkg: PackageJson) {
  let entry = pkg.exports?.['.'] ?? pkg.exports ?? pkg.module ?? pkg.main ?? 'index.js'
  while (entry && typeof entry === 'object') {
    entry = entry.import ?? entry.node ?? entry.default ?? entry.require
  }
  return resolve(dir, typeof entry === 'string' ? entry : 'index.js')
}

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function listPackageDirs(nodeModules: string) {
  const dirs: string[] = []
  let names: string[]
  try {
    names = await readdir(nodeModules)
  } catch {
    return dirs
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const full = join(nodeModules, name)
    if (name.startsWith('@')) {
      for (const sub of await readdir(full).catch(() => [] as string[])) {
        dirs.push(join(full, sub))
      }
    } else {
      dirs.push(full)
    }
  }
  return dirs
}

/** Finds installed packages that carry a `mushin` manifest. Earlier directories win on duplicates. */
export async function scanCatalog(nodeModulesDirs: string[], localDirs: string[]) {
  const found = new Map<string, CatalogEntry>()
  const add = async (dir: string, local: boolean) => {
    const pkg = await readPackageJson(dir)
    if (!pkg?.name || !pkg.mushin || found.has(pkg.name)) return
    found.set(pkg.name, { package: pkg.name, version: pkg.version ?? '0.0.0', path: dir, local, manifest: pkg.mushin })
  }
  for (const localDir of localDirs) {
    for (const name of await readdir(localDir).catch(() => [] as string[])) {
      const dir = join(localDir, name)
      if (await isDirectory(dir)) await add(dir, true)
    }
  }
  for (const nodeModules of nodeModulesDirs) {
    for (const dir of await listPackageDirs(nodeModules)) await add(dir, false)
  }
  return [...found.values()].sort((a, b) => a.package.localeCompare(b.package))
}
