import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

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
