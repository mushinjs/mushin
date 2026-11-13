import { cp, mkdir, readdir, rename, rmdir, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { readJson, writeJsonAtomic } from '@mushinjs/core'

/**
 * Where storage keys live on disk. Keys stay what plugins already use (`bots`, `flows/<id>`,
 * `messages/<bot>/<day>`); this table decides the folder, so the layout is defined in one place:
 *
 *   data/core/                small documents of the core plugins: bots, providers, permissions, sign-in
 *   data/bots/<id>/messages/  one bot's message log
 *   data/agents/              Agent sessions, skills and settings
 *   data/plugins/<name>/      everything else, one folder per plugin
 *   logs/bots/<id>/           bot logs, safe to delete
 *
 * `data/mushin.db` (the database) and `data/backups/` sit beside these folders.
 */

export type Root = 'data' | 'logs' | 'cache'

/** Layout version written to `data/layout.json`. Version 1 is the flat layout: `data/<key>.json`. */
export const LAYOUT_VERSION = 2
const LAYOUT_FILE = 'layout.json'

interface Rule {
  /** Key segments: a literal, `:name` for one segment, or `*` (last) for one or more. */
  key: string[]
  root: Root
  path: string[]
}

const rule = (key: string, to: string): Rule => {
  const at = to.indexOf(':')
  return { key: key.split('/'), root: to.slice(0, at) as Root, path: to.slice(at + 1).split('/') }
}

// First match wins.
const RULES: Rule[] = [
  rule('bots', 'data:core/bots'),
  rule('providers', 'data:core/providers'),
  rule('permissions', 'data:core/permissions'),
  rule('auth', 'data:core/auth'),
  rule('messages/:bot/*', 'data:bots/:bot/messages/*'),
  rule('logs/:bot/*', 'logs:bots/:bot/*'),
  rule('agent/skills/*', 'data:agents/skills/*'),
  rule('agent/settings/*', 'data:agents/settings/*'),
  rule('agent/*', 'data:agents/sessions/*'),
  rule('flows/*', 'data:plugins/flows/documents/*'),
  rule('flows-tests/*', 'data:plugins/flows/tests/*'),
  rule('flows-tables', 'data:plugins/flows/tables'),
  rule('flows-usage', 'data:plugins/flows/usage'),
  rule('demo', 'data:plugins/demo/state'),
  // Any other key belongs to the plugin its first segment names.
  rule(':plugin/*', 'data:plugins/:plugin/*'),
  rule(':plugin', 'data:plugins/:plugin/index'),
]

/** The root and path segments (without extension) of a key. */
export function locate(key: string): { root: Root; path: string[] } {
  const segments = key.split('/')
  for (const { key: pattern, root, path } of RULES) {
    const bound = match(pattern, segments)
    if (bound) return { root, path: path.flatMap((part) => part === '*' ? bound.rest : part.startsWith(':') ? [bound.params[part]!] : [part]) }
  }
  throw new Error(`no storage location for "${key}"`)
}

function match(pattern: string[], segments: string[]) {
  const params: Record<string, string> = {}
  for (let i = 0; i < pattern.length; i++) {
    const part = pattern[i]!
    if (part === '*') {
      const rest = segments.slice(i)
      return rest.length ? { params, rest } : undefined
    }
    const segment = segments[i]
    if (segment === undefined) return undefined
    if (part.startsWith(':')) params[part] = segment
    else if (part !== segment) return undefined
  }
  return segments.length === pattern.length ? { params, rest: [] } : undefined
}

export interface LayoutDirs {
  data: string
  logs: string
  cache: string
}

/** Absolute path of a key, without extension. */
export function pathOf(dirs: LayoutDirs, key: string) {
  const { root, path } = locate(key)
  return join(dirs[root], ...path)
}

/**
 * Names directly under a key prefix. Under `messages` (a `:bot` segment) these are the bots that
 * have a message folder; under `agent/skills` they are the names in that folder.
 */
export async function childrenOf(dirs: LayoutDirs, prefix: string): Promise<string[]> {
  const segments = prefix.split('/')
  for (const { key: pattern, root, path } of RULES) {
    const next = pattern[segments.length]
    const bound = next ? match(pattern.slice(0, segments.length), segments) : undefined
    if (!next || !bound) continue
    if (next.startsWith(':')) {
      // The names sit where the parameter does in the path; keep those that have the rest of it.
      const at = path.indexOf(next)
      const fill = (parts: string[]) => parts.map((part) => bound.params[part] ?? part)
      const parent = join(dirs[root], ...fill(path.slice(0, at)))
      const suffix = fill(path.slice(at + 1)).filter((part) => part !== '*')
      const kept: string[] = []
      for (const name of await readdir(parent).catch(() => [] as string[])) {
        if (await exists(join(parent, name, ...suffix))) kept.push(name)
      }
      return kept
    }
    if (next === '*') {
      const at = path.indexOf('*')
      const fill = path.slice(0, at).map((part) => bound.params[part] ?? part)
      return readdir(join(dirs[root], ...fill)).catch(() => [] as string[])
    }
  }
  return []
}

export interface Move {
  from: string
  to: string
}

export interface MigrationResult {
  /** The layout version found, or `undefined` for an empty or new data folder. */
  from?: number
  moves: Move[]
  /** Where the copy of the old data folder went. */
  backup?: string
}

const KEEP = new Set(['mushin.db', 'mushin.db-journal', 'mushin.db-wal', 'mushin.db-shm', 'backups', LAYOUT_FILE])

async function exists(path: string) {
  return stat(path).then(() => true, () => false)
}

async function filesUnder(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(full))
    else files.push(full)
  }
  return files
}

/** The current layout version of a data folder: `undefined` when it holds nothing yet. */
export async function layoutVersion(dataDir: string) {
  const marker = await readJson<{ version?: number }>(join(dataDir, LAYOUT_FILE))
  if (marker?.version) return marker.version
  const names = (await readdir(dataDir).catch(() => [] as string[])).filter((name) => !KEEP.has(name))
  return names.length ? 1 : undefined
}

/**
 * Moves a data folder in the flat layout (version 1) to the current one. It copies the folder to
 * `data/backups/<time>-layout-1/` first. Running it again changes nothing. With `dryRun`, it only
 * reports the moves.
 */
export async function migrateLayout(dirs: LayoutDirs, options: { dryRun?: boolean; now?: Date } = {}): Promise<MigrationResult> {
  const from = await layoutVersion(dirs.data)
  if (from === LAYOUT_VERSION) return { from, moves: [] }
  if (from !== undefined && from > LAYOUT_VERSION) {
    throw new Error(`the data folder uses layout version ${from}, newer than this Mushin.js understands (${LAYOUT_VERSION}); upgrade Mushin.js`)
  }
  const moves: Move[] = []
  if (from === 1) {
    for (const file of await filesUnder(dirs.data)) {
      const rel = relative(dirs.data, file).split(sep)
      if (KEEP.has(rel[0]!)) continue
      const name = rel.at(-1)!
      const dot = name.lastIndexOf('.')
      // `.json` and `.jsonl` documents are keys; other files (such as knowledge base sources) keep their name.
      const ext = dot > 0 && /^\.jsonl?$/.test(name.slice(dot)) ? name.slice(dot) : ''
      const key = [...rel.slice(0, -1), ext ? name.slice(0, dot) : name].join('/')
      const to = pathOf(dirs, key) + ext
      if (to !== file) moves.push({ from: file, to })
    }
  }
  if (options.dryRun) return { from, moves }

  let backup: string | undefined
  if (moves.length) {
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
    backup = join(dirs.data, 'backups', `${stamp}-layout-${from}`)
    await mkdir(backup, { recursive: true })
    for (const name of await readdir(dirs.data)) {
      if (name === 'backups') continue
      await cp(join(dirs.data, name), join(backup, name), { recursive: true, preserveTimestamps: true })
    }
    for (const { from: source, to } of moves) {
      if (await exists(to)) throw new Error(`cannot move ${source}: ${to} already exists`)
      await mkdir(dirname(to), { recursive: true })
      await rename(source, to)
    }
    // Remove the old folders the moves emptied, deepest first.
    const emptied = new Set(moves.flatMap(({ from: source }) => {
      const parents: string[] = []
      for (let dir = dirname(source); dir !== dirs.data && dir.startsWith(dirs.data); dir = dirname(dir)) parents.push(dir)
      return parents
    }))
    for (const dir of [...emptied].sort((a, b) => b.length - a.length)) await rmdir(dir).catch(() => {})
  }
  await writeJsonAtomic(join(dirs.data, LAYOUT_FILE), { version: LAYOUT_VERSION })
  return { from, moves, backup }
}

/** The `.json` file of a key that lives in the data directory, for tools that run without a started instance. */
export function dataFile(dataDir: string, key: string) {
  const { root, path } = locate(key)
  if (root !== 'data') throw new Error(`"${key}" is not stored in the data directory`)
  return join(dataDir, ...path) + '.json'
}
