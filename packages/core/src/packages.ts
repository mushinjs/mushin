/**
 * The npm packages of a Mushin.js app: which ones it has, the commands that install them, and which newer versions
 * the registry offers. Only Node built-ins are used here, so the supervisor (which must not load any plugin) can
 * import this file on its own through `@mushinjs/core/system`.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { compareVersions, parseVersion, satisfies } from './semver'

export type PackageManager = 'npm' | 'pnpm'

/** The registry npm uses when the app does not name another. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

/** Where the release notes of a Mushin.js version live. */
export const RELEASES_URL = 'https://github.com/mushinjs/mushin/releases'
export const CHANGELOG_URL = 'https://github.com/mushinjs/mushin/blob/main/packages/cli/CHANGELOG.md'

/** How often the registry is asked again. */
export const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000

interface AppPackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readJsonSync<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** The package manager an app uses, from its lock file. */
export function appPackageManager(baseDir: string): PackageManager {
  return existsSync(join(baseDir, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm'
}

/** The lock file of an app, if it has one. */
export function appLockFile(baseDir: string) {
  return ['pnpm-lock.yaml', 'package-lock.json'].map((name) => join(baseDir, name)).find((file) => existsSync(file))
}

/** Every package an app depends on, by name, with its range. */
export function appDependencies(baseDir: string): Record<string, string> | undefined {
  const pkg = readJsonSync<AppPackageJson>(join(baseDir, 'package.json'))
  return pkg ? { ...pkg.devDependencies, ...pkg.dependencies } : undefined
}

/** The `@mushinjs/*` packages an app depends on. */
export async function appPackages(baseDir: string) {
  const deps = appDependencies(baseDir)
  if (!deps) return undefined
  return Object.keys(deps).filter((name) => name.startsWith('@mushinjs/')).sort()
}

/** The dist-tag an upgrade follows: `next` for a preview, `latest` for a release. */
export function upgradeTag(version: string) {
  return version.includes('-next') ? 'next' : 'latest'
}

/** The command that installs `specs`, such as `@mushinjs/cli@0.4.0`. */
export function installCommand(packageManager: PackageManager, specs: string[]) {
  return packageManager === 'pnpm' ? ['pnpm', ['add', ...specs]] as const : ['npm', ['install', ...specs]] as const
}

/** The command that installs what package.json and the lock file say, after they were put back. */
export function reinstallCommand(packageManager: PackageManager) {
  return packageManager === 'pnpm' ? ['pnpm', ['install']] as const : ['npm', ['install']] as const
}

/** The command that installs `packages` at `tag`. */
export function upgradeCommand(packageManager: PackageManager, packages: string[], tag: string) {
  return installCommand(packageManager, packages.map((name) => `${name}@${tag}`))
}

export interface RunOptions {
  /** Called with each piece of output; without it the output goes to this terminal. */
  output?: (chunk: string) => void
}

export function run(command: string, args: readonly string[], cwd: string, options: RunOptions = {}) {
  return new Promise<void>((done, reject) => {
    // npm and pnpm are .cmd files on Windows, which only start through a shell.
    const child = spawn(command, args, {
      cwd,
      stdio: options.output ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: process.platform === 'win32' && command !== process.execPath,
    })
    child.stdout?.on('data', (chunk: Buffer) => options.output!(chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => options.output!(chunk.toString()))
    child.on('error', reject)
    child.on('exit', (code) => (code ? reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)) : done()))
  })
}

// ---- the registry ----

const registries = new Map<string, Promise<string>>()

/** The registry npm uses in the app's folder (its .npmrc, the user's, or the default), asked once per folder. */
export function registryUrl(baseDir: string): Promise<string> {
  let found = registries.get(baseDir)
  if (!found) {
    found = new Promise<string>((resolve) => {
      execFile('npm', ['config', 'get', 'registry'], { cwd: baseDir, shell: process.platform === 'win32', timeout: 15_000 }, (error, stdout) => {
        const value = String(stdout ?? '').trim()
        resolve(!error && /^https?:\/\//.test(value) ? value : DEFAULT_REGISTRY)
      })
    })
    registries.set(baseDir, found)
  }
  return found
}

export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>

const packageUrl = (registry: string, name: string, version?: string) =>
  `${registry.replace(/\/?$/, '/')}${name.replace('/', '%2F')}${version ? `/${encodeURIComponent(version)}` : ''}`

async function getJson(fetcher: Fetch, url: string, accept = 'application/json') {
  const response = await fetcher(url, { headers: { accept }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

/** A package's dist-tags and versions, from the abbreviated document npm itself installs from. */
export async function fetchDistTags(name: string, options: { registry: string; fetch?: Fetch }) {
  const doc = await getJson(options.fetch ?? (fetch as Fetch), packageUrl(options.registry, name), 'application/vnd.npm.install-v1+json')
  return { tags: (doc['dist-tags'] ?? {}) as Record<string, string>, versions: Object.keys(doc.versions ?? {}) }
}

/** The package.json of one published version, for its `mushin` manifest. */
export async function fetchVersion(name: string, version: string, options: { registry: string; fetch?: Fetch }) {
  return getJson(options.fetch ?? (fetch as Fetch), packageUrl(options.registry, name, version)) as Promise<{ version: string; mushin?: { requires?: { mushin?: string } } }>
}

/**
 * Compares two versions with their prerelease tags, as npm does: `0.4.0-next.2` < `0.4.0-next.10` < `0.4.0`.
 * (semver.ts ignores prerelease tags, which is right for dependency ranges but not for updates.)
 */
export function compareFullVersions(a: string, b: string) {
  const [coreA, preA] = splitVersion(a)
  const [coreB, preB] = splitVersion(b)
  const base = compareVersions(coreA, coreB)
  if (base || preA === preB) return base
  if (!preA) return 1
  if (!preB) return -1
  const partsA = preA.split('.')
  const partsB = preB.split('.')
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i]
    const y = partsB[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y)
    return numeric ? (Number(x) < Number(y) ? -1 : 1) : x < y ? -1 : 1
  }
  return 0
}

function splitVersion(text: string) {
  const pre = /^[^-+]*-([^+]*)/.exec(text.trim())?.[1] ?? ''
  return [parseVersion(text)!, pre] as const
}

/** Whether `next` is a newer version than `current`. */
export function isNewer(next: string | undefined, current: string | undefined) {
  if (!next || !current || !parseVersion(next) || !parseVersion(current)) return false
  return compareFullVersions(next, current) > 0
}

// ---- checking for updates ----

export type UpdateChannel = 'latest' | 'next'

export interface MushinUpdate {
  current: string
  /** The newer version on the channel, when there is one. */
  available?: string
  channel: UpdateChannel
  /** The official packages the app lists; they always update together. */
  packages: string[]
  notesUrl: string
  /** The start of the release notes, when the release has them. */
  notes?: string
}

export interface PluginUpdate {
  package: string
  current: string
  available?: string
  /** Whether the newer version runs on this Mushin.js version. */
  compatible: boolean
  /** Its `mushin.requires.mushin` range. */
  requires?: string
  error?: string
}

export interface UpdateReport {
  checkedAt: number
  /** `development`: the app does not install Mushin.js from npm (this repository), so nothing updates from here. */
  mode: 'app' | 'development'
  registry?: string
  mushin?: MushinUpdate
  plugins: PluginUpdate[]
  error?: string
}

export interface CheckOptions {
  baseDir: string
  /** The running Mushin.js version. */
  version: string
  /** The channel to follow; by default `next` for a preview and `latest` otherwise. */
  channel?: UpdateChannel
  /** Installed third-party plugins to check besides the app's dependencies, such as entries in the config. */
  extraPackages?: string[]
  fetch?: Fetch
  registry?: string
  /** Release notes of a version, when they can be had. */
  notes?: (version: string) => Promise<string | undefined>
  now?: () => number
}

/** The installed version and manifest of a package in the app's node_modules. */
function installed(baseDir: string, name: string) {
  return readJsonSync<{ version?: string; mushin?: unknown }>(join(baseDir, 'node_modules', name, 'package.json'))
}

/**
 * Which newer versions the registry has: one for Mushin.js (all `@mushinjs/*` packages share a version, so
 * `@mushinjs/cli` speaks for them) and one per third-party plugin the app installs from npm, with whether it runs on
 * this Mushin.js version. An app without `@mushinjs/*` dependencies is the repository itself: nothing to update.
 */
export async function checkUpdates(options: CheckOptions): Promise<UpdateReport> {
  const now = options.now ?? Date.now
  const deps = appDependencies(options.baseDir) ?? {}
  const official = Object.keys(deps).filter((name) => name.startsWith('@mushinjs/')).sort()
  if (!official.length) return { checkedAt: now(), mode: 'development', plugins: [] }

  const registry = options.registry ?? await registryUrl(options.baseDir)
  const fetcher = options.fetch
  const channel = options.channel ?? upgradeTag(options.version)
  const report: UpdateReport = { checkedAt: now(), mode: 'app', registry, plugins: [] }

  try {
    const { tags } = await fetchDistTags('@mushinjs/cli', { registry, fetch: fetcher })
    // The newer of the channel's version and latest: a preview of 0.4 is old once 0.4.0 is out.
    let available = tags[channel]
    if (channel === 'next' && isNewer(tags.latest, available)) available = tags.latest
    const update: MushinUpdate = {
      current: options.version,
      channel,
      packages: official,
      notesUrl: CHANGELOG_URL,
    }
    if (isNewer(available, options.version)) {
      update.available = available
      if (!available!.includes('-')) update.notesUrl = `${RELEASES_URL}/tag/v${available}`
      update.notes = await options.notes?.(available!).catch(() => undefined)
    }
    report.mushin = update
  } catch (error) {
    report.error = (error as Error).message
  }

  const thirdParty = new Set([...Object.keys(deps), ...(options.extraPackages ?? [])].filter((name) => !name.startsWith('@mushinjs/') && !name.startsWith('@cordisjs/')))
  for (const name of [...thirdParty].sort()) {
    const pkg = installed(options.baseDir, name)
    if (!pkg?.mushin || !pkg.version) continue
    const entry: PluginUpdate = { package: name, current: pkg.version, compatible: true }
    try {
      const { tags } = await fetchDistTags(name, { registry, fetch: fetcher })
      if (isNewer(tags.latest, pkg.version)) {
        entry.available = tags.latest
        const doc = await fetchVersion(name, tags.latest!, { registry, fetch: fetcher })
        entry.requires = doc.mushin?.requires?.mushin
        entry.compatible = !entry.requires || satisfies(options.version, entry.requires)
      }
    } catch (error) {
      entry.error = (error as Error).message
    }
    report.plugins.push(entry)
  }
  return report
}

/** How many updates a report offers: Mushin.js counts once. */
export function updateCount(report: UpdateReport | undefined) {
  if (!report || report.mode !== 'app') return 0
  return (report.mushin?.available ? 1 : 0) + report.plugins.filter((plugin) => plugin.available).length
}

// ---- the files of an update ----

/** What the app asks the supervisor to install, written before it stops. */
export interface UpgradePlan {
  packages: string[]
  from: string
  to?: string
  time: number
  /** The app's data folder, so a data migration of the new version can be undone. */
  dataDir: string
  logsDir: string
}

/** How the last update went, written by the supervisor and read by the app when it starts. */
export interface UpgradeResult {
  ok: boolean
  from: string
  to?: string
  /** The version that runs now. */
  version?: string
  packages: string[]
  error?: string
  log?: string
  time: number
  /** Set once the dashboard showed it. */
  seen?: boolean
}

/** The folder of update plans and results, inside the data folder. */
export const upgradeDir = (dataDir: string) => join(dataDir, '.upgrade')

export async function writeJsonFile(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n')
  await rename(temp, file)
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return undefined
  }
}
