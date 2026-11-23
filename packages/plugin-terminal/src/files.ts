import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MushinError } from '@mushinjs/core'

/**
 * Files in the app folder (and any extra roots), for Fairy: list, read, search, write and edit. Paths are relative to
 * the first root unless absolute; nothing outside the roots is reachable, `.env` files never are, and writes stay out
 * of `data/`, `node_modules/` and `.git/`.
 */
export interface FileRoots {
  /** The app folder first; relative paths start there. */
  roots: string[]
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.turbo', '.cache', 'logs'])
const READ_LIMIT = 2000
const MAX_FILE = 2 * 1024 * 1024

const isSecret = (path: string) => /(^|[\\/])\.env(\.[^\\/]*)?$/i.test(path)

const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The real path of a target inside one of the roots, or an error naming why not. */
export async function resolveInRoots(files: FileRoots, path: string, options: { write?: boolean } = {}) {
  const base = files.roots[0]!
  const wanted = resolve(base, path || '.')
  if (isSecret(wanted)) throw new MushinError('forbidden', '.env files hold secrets and are never read or written by Fairy')
  // Follow links that exist, so a link cannot lead out of a root; a new file is checked through its folder.
  let real = wanted
  try {
    real = await realpath(wanted)
  } catch {
    try {
      real = join(await realpath(dirname(wanted)), wanted.slice(dirname(wanted).length + 1))
    } catch {}
  }
  const roots = await Promise.all(files.roots.map((root) => realpath(root).catch(() => resolve(root))))
  const root = roots.find((item) => inside(item, real))
  if (!root) throw new MushinError('forbidden', `${path} is outside the folders Fairy may use (${files.roots.join(', ')})`)
  if (options.write) {
    const parts = relative(root, real).split(/[\\/]/)
    if (parts[0] === 'data' || parts.includes('node_modules') || parts.includes('.git')) {
      throw new MushinError('forbidden', 'Fairy does not write under data/, node_modules/ or .git/; use the actions that manage them instead')
    }
  }
  return { path: real, root, display: relative(base, real).split(sep).join('/') || '.' }
}

export async function listFiles(files: FileRoots, path = '.', depth = 1) {
  const { path: dir, display } = await resolveInRoots(files, path)
  const out: { path: string; type: 'file' | 'dir'; size?: number }[] = []
  let truncated = false
  const walk = async (current: string, level: number) => {
    const entries = await readdir(current, { withFileTypes: true }).catch((error) => {
      throw new MushinError('not_found', `Cannot list ${display}: ${(error as Error).message}`)
    })
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (out.length >= 500) {
        truncated = true
        return
      }
      const full = join(current, entry.name)
      const shown = relative(files.roots[0]!, full).split(sep).join('/')
      if (isSecret(full)) continue
      if (entry.isDirectory()) {
        out.push({ path: `${shown}/`, type: 'dir' })
        if (level < depth && !SKIP_DIRS.has(entry.name)) await walk(full, level + 1)
      } else if (entry.isFile()) {
        const size = await stat(full).then((info) => info.size, () => undefined)
        out.push({ path: shown, type: 'file', ...(size !== undefined ? { size } : {}) })
      }
    }
  }
  await walk(dir, 1)
  return { path: display, entries: out, ...(truncated ? { truncated: true } : {}) }
}

export async function readText(files: FileRoots, path: string, offset = 1, limit = READ_LIMIT) {
  const { path: file, display } = await resolveInRoots(files, path)
  const info = await stat(file).catch(() => undefined)
  if (!info?.isFile()) throw new MushinError('not_found', `No file ${display}`)
  if (info.size > MAX_FILE) throw new MushinError('invalid_input', `${display} is ${Math.round(info.size / 1024)} KB, too big to read whole; search it instead`)
  const buffer = await readFile(file)
  if (buffer.subarray(0, 8000).includes(0)) throw new MushinError('invalid_input', `${display} is not a text file`)
  const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n')
  const start = Math.max(1, offset)
  const shown = lines.slice(start - 1, start - 1 + limit)
  return {
    path: display,
    lines: lines.length,
    from: start,
    to: start + shown.length - 1,
    text: shown.join('\n'),
    ...(start - 1 + shown.length < lines.length ? { more: `Read on with offset ${start + shown.length}` } : {}),
  }
}

/** Lines that match, in text files under a folder; `query` is a regular expression unless `literal`. */
export async function searchFiles(files: FileRoots, query: string, options: { path?: string; glob?: string; literal?: boolean; limit?: number } = {}) {
  const { path: dir } = await resolveInRoots(files, options.path ?? '.')
  let pattern: RegExp
  try {
    pattern = new RegExp(options.literal ? query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : query, 'i')
  } catch (error) {
    throw new MushinError('invalid_input', `Not a regular expression: ${(error as Error).message}; pass literal: true to search for the text`)
  }
  const glob = options.glob ? globPattern(options.glob) : undefined
  const limit = Math.min(options.limit ?? 100, 500)
  const matches: { path: string; line: number; text: string }[] = []
  let scanned = 0
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (matches.length >= limit || scanned > 5000) return
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && entry.name !== 'data') await walk(full)
        continue
      }
      if (!entry.isFile() || isSecret(full)) continue
      const shown = relative(files.roots[0]!, full).split(sep).join('/')
      if (glob && !glob.test(shown) && !glob.test(entry.name)) continue
      scanned++
      const info = await stat(full).catch(() => undefined)
      if (!info || info.size > MAX_FILE) continue
      const buffer = await readFile(full).catch(() => undefined)
      if (!buffer || buffer.subarray(0, 8000).includes(0)) continue
      const lines = buffer.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length && matches.length < limit; i++) {
        if (pattern.test(lines[i]!)) matches.push({ path: shown, line: i + 1, text: lines[i]!.slice(0, 300) })
      }
    }
  }
  await walk(dir)
  return { matches, ...(matches.length >= limit ? { truncated: true } : {}) }
}

export async function writeText(files: FileRoots, path: string, content: string) {
  const { path: file, display } = await resolveInRoots(files, path, { write: true })
  const existed = await stat(file).then((info) => info.isFile(), () => false)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
  return { path: display, created: !existed, bytes: Buffer.byteLength(content) }
}

/** Replaces `old` with `replacement`: exactly once unless `all`. */
export async function editText(files: FileRoots, path: string, old: string, replacement: string, all = false) {
  const { path: file, display } = await resolveInRoots(files, path, { write: true })
  const text = await readFile(file, 'utf8').catch(() => {
    throw new MushinError('not_found', `No file ${display}`)
  })
  // Files with CRLF line ends match text written with LF.
  const crlf = text.includes('\r\n')
  const source = crlf ? text.replace(/\r\n/g, '\n') : text
  const count = old ? source.split(old).length - 1 : 0
  if (!count) throw new MushinError('invalid_input', `The text to replace is not in ${display}; read the file again and copy it exactly`)
  if (count > 1 && !all) throw new MushinError('invalid_input', `The text to replace appears ${count} times in ${display}; add more around it, or pass all: true`)
  let next = all ? source.split(old).join(replacement) : source.replace(old, () => replacement)
  if (crlf) next = next.replace(/\n/g, '\r\n')
  await writeFile(file, next)
  return { path: display, replaced: all ? count : 1 }
}

/** `*.ts`, `src/**\/*.vue` and the like, as a regular expression over `/`-separated paths. */
function globPattern(glob: string) {
  const source = glob.split(/(\*\*\/|\*\*|\*|\?)/).map((part) => {
    if (part === '**/') return '(?:.*/)?'
    if (part === '**') return '.*'
    if (part === '*') return '[^/]*'
    if (part === '?') return '[^/]'
    return part.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }).join('')
  return new RegExp(`^${source}$`, 'i')
}
