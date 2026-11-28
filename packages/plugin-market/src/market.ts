/**
 * The plugin market: what can be installed (from the market index, or from npm when no index answers), the details of
 * one package, installing and uninstalling. A new package that leaves the installed ones alone is installed while the
 * app runs and picked up by a rescan; one that would change installed packages goes through the supervisor, which
 * stops the app, installs, starts it again and rolls back when it does not come up.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appDependencies, appPackageManager, chooseVersion, type Context, DEFAULT_MARKET_INDEXES, DEFAULT_REGISTRY, type Fetch,
  fetchPackageDetail, forgetRegistry, installCommand, isMarketIndex, type MarketEntry, missingRequirements, MUSHIN_VERSION,
  MushinError, NPMMIRROR_REGISTRY, previewInstall, readJsonFile, registryUrl, run, searchRegistry, supervisor,
  uninstallCommand, type UpgradePlan, writeJsonFile, z,
} from '@mushinjs/core'

/** How long a market listing is kept before asking again. */
export const MARKET_CACHE_TIME = 3 * 60 * 60 * 1000

export interface MarketSettings {
  /** Index addresses, tried in order. */
  indexes: string[]
  /** Only picked (curated) plugins and official ones can be installed. */
  curatedOnly: boolean
}

interface Listing {
  fetchedAt: number
  /** Where it came from: an index, or the registry's search. */
  source: 'index' | 'npm'
  url: string
  entries: MarketEntry[]
  /** Why the indexes could not be read, when the registry stood in. */
  indexError?: string
}

export interface MarketDeps {
  baseDir: string
  dataDir: string
  logsDir: string
  link: () => ReturnType<typeof supervisor>
  startPlan: (plan: Pick<UpgradePlan, 'kind' | 'packages' | 'remove' | 'to'>) => Promise<UpgradePlan>
  /** After an install or uninstall in place: the update check sees the new packages. */
  afterChange: () => void
  fetch?: Fetch
}

const NO_SUPERVISOR = 'Installing from the market needs Mushin.js started with "mushin start" (without --no-supervisor). Stop it and start it again that way.'
const DEVELOPMENT = 'This copy of Mushin.js runs from source: add plugins to its package.json and install them with pnpm instead.'

/** Reads a registry line out of an .npmrc, if the app sets one. */
function npmrcRegistry(text: string) {
  return /^\s*registry\s*=\s*(\S+)\s*$/m.exec(text)?.[1]
}

/**
 * What installing a market package means: `name@version` for it (the newest that runs on this Mushin.js unless one is
 * asked for) and for each plugin it needs that is not installed. Throws with the reason when it cannot be done.
 */
export function planInstall(entries: MarketEntry[], name: string, options: { version?: string; installed: (name: string) => boolean; mushinVersion: string; curatedOnly?: boolean }) {
  const entry = entries.find((item) => item.name === name)
  if (!entry) throw new MushinError('not_found', `${name} is not in the plugin market`)
  if (options.curatedOnly && !entry.curated && !entry.official) throw new MushinError('forbidden', `Only picked plugins can be installed (a market setting), and ${name} is not one`)
  const choice = chooseVersion(entry, options.mushinVersion)
  const target = options.version ?? choice.version
  if (!target) throw new MushinError('conflict', `No version of ${name} runs on Mushin.js ${options.mushinVersion}; it needs ${choice.needs}`)
  const specs = [`${name}@${target}`]
  for (const pkg of missingRequirements(entry, options.installed)) {
    const other = entries.find((item) => item.name === pkg)
    const otherVersion = other && chooseVersion(other, options.mushinVersion).version
    if (!otherVersion) throw new MushinError('conflict', `${name} needs ${pkg}, which ${other ? 'has no version for this Mushin.js' : 'is not in the plugin market'}`)
    specs.push(`${pkg}@${otherVersion}`)
  }
  return specs
}

/**
 * Whether npm's dry run allows changing the packages while the app runs: only additions, and removals of packages
 * nobody has loaded. Without a dry run (pnpm, or npm not saying) the supervisor does it.
 */
export function changesInPlace(preview: { changed: string[]; removed: string[] } | undefined, untouched: (name: string) => boolean): preview is { added: string[]; changed: string[]; removed: string[] } {
  return !!preview && !preview.changed.length && preview.removed.every(untouched)
}

export function defineMarket(ctx: Context, deps: MarketDeps) {
  const logger = ctx.logger('market')
  const { baseDir } = deps
  const cacheFile = join(deps.dataDir, 'market.json')
  const settingsFile = join(deps.dataDir, 'market-settings.json')
  const fetcher = deps.fetch ?? (fetch as Fetch)
  let listing: Listing | undefined
  let loading: Promise<Listing> | undefined

  const settings = async (): Promise<MarketSettings> => ({ indexes: DEFAULT_MARKET_INDEXES, curatedOnly: false, ...await readJsonFile<Partial<MarketSettings>>(settingsFile) })
  /** An app that installs Mushin.js from npm, as opposed to this repository run from source. */
  const isApp = () => Object.keys(appDependencies(baseDir) ?? {}).some((name) => name.startsWith('@mushinjs/'))
  const manager = () => {
    const value = ctx.get('manager')
    if (!value) throw new MushinError('unavailable', 'The plugin manager is not running')
    return value
  }

  async function load(): Promise<Listing> {
    const { indexes } = await settings()
    const problems: string[] = []
    for (const url of indexes) {
      try {
        const response = await fetcher(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const index = await response.json()
        if (!isMarketIndex(index)) throw new Error('not a market index this version can read')
        return { fetchedAt: Date.now(), source: 'index', url, entries: index.packages }
      } catch (error) {
        problems.push(`${url}: ${(error as Error).message}`)
      }
    }
    // No index answered: the registry's own search, slower but always there.
    const registry = await registryUrl(baseDir)
    const entries = await searchRegistry({ registry, fetch: fetcher })
    return { fetchedAt: Date.now(), source: 'npm', url: registry, entries, ...(problems.length ? { indexError: problems.join('; ') } : {}) }
  }

  async function current(refresh = false) {
    listing ??= await readJsonFile<Listing>(cacheFile)
    if (!refresh && listing && Date.now() - listing.fetchedAt < MARKET_CACHE_TIME) return listing
    loading ??= load()
      .then(async (next) => {
        listing = next
        await writeJsonFile(cacheFile, next).catch(() => {})
        return next
      })
      .finally(() => (loading = undefined))
    return loading
  }

  /** What is installed: version, whether it came with Mushin.js, and whether it is a local folder. */
  async function installed() {
    const catalog = await manager().catalog()
    const own = appDependencies(baseDir) ?? {}
    return new Map(catalog.map((entry) => [entry.package, {
      version: entry.version,
      local: entry.local,
      // Official packages the app does not list itself came with the CLI: they can be turned off, not removed.
      builtin: entry.package.startsWith('@mushinjs/') && !own[entry.package] && !entry.local,
      ownDependency: !!own[entry.package],
    }]))
  }

  function describe(entry: MarketEntry, have: Awaited<ReturnType<typeof installed>>, curatedOnly: boolean) {
    const choice = chooseVersion(entry, MUSHIN_VERSION)
    const mine = have.get(entry.name)
    return {
      ...entry,
      choice,
      installed: mine,
      // A newer version that runs here, for packages installed from npm.
      update: mine && choice.version && !mine.local && choice.version !== mine.version ? choice.version : undefined,
      allowed: !curatedOnly || !!entry.curated || !!entry.official,
    }
  }

  ctx.actions.define({
    name: 'market.list',
    description: 'The plugin market: plugin packages that can be installed, from the market index (or npm\'s search when no index answers), each with the version that runs on this Mushin.js, whether it is installed, and whether it is official, picked or published with trusted publishing.',
    risk: 'read',
    input: z.object({ refresh: z.boolean().optional().describe('Ask the index or registry again instead of the listing kept for a few hours') }),
    handler: async ({ refresh }) => {
      const [value, have, config, registry] = await Promise.all([current(!!refresh), installed(), settings(), registryUrl(baseDir)])
      return {
        source: value.source,
        url: value.url,
        fetchedAt: value.fetchedAt,
        indexError: value.indexError,
        registry,
        version: MUSHIN_VERSION,
        mode: isApp() ? 'app' : 'development',
        supervised: !!deps.link(),
        settings: config,
        entries: value.entries.map((entry) => describe(entry, have, config.curatedOnly)),
      }
    },
  })

  ctx.actions.define({
    name: 'market.package',
    description: 'One package of the plugin market in full: its README, every version with the Mushin.js versions it runs on, the version that would be installed, and the plugins it needs that would be installed with it.',
    risk: 'read',
    input: z.object({ name: z.string() }),
    handler: async ({ name }) => {
      const [value, have, config, registry] = await Promise.all([current(), installed(), settings(), registryUrl(baseDir)])
      const known = value.entries.find((entry) => entry.name === name)
      const detail = await fetchPackageDetail(name, { registry, fetch: fetcher }).catch((error: Error) => ({ error: error.message }))
      const fromRegistry = 'versions' in detail ? detail : undefined
      const entry: MarketEntry | undefined = known
        ? { ...known, versions: fromRegistry?.versions.length ? fromRegistry.versions : known.versions }
        : undefined
      if (!entry) throw new MushinError('not_found', `${name} is not in the plugin market`)
      const described = describe(entry, have, config.curatedOnly)
      const brings = missingRequirements(entry, (pkg) => have.has(pkg)).map((pkg) => {
        const other = value.entries.find((item) => item.name === pkg)
        return { name: pkg, version: other ? chooseVersion(other, MUSHIN_VERSION).version : undefined, inMarket: !!other }
      })
      return { ...described, readme: fromRegistry?.readme ?? entry.readme, brings, ...('error' in detail ? { detailError: detail.error } : {}) }
    },
  })

  ctx.actions.define({
    name: 'market.settings',
    description: 'Read or change the plugin market settings: the index addresses (tried in order), whether only picked plugins can be installed, and the npm registry this app installs from (written to its .npmrc).',
    risk: 'write',
    input: z.object({
      indexes: z.array(z.string().url()).optional(),
      curatedOnly: z.boolean().optional(),
      registry: z.string().url().optional().describe(`A registry address, such as ${NPMMIRROR_REGISTRY} or ${DEFAULT_REGISTRY}`),
    }),
    handler: async ({ indexes, curatedOnly, registry }) => {
      if (indexes || curatedOnly !== undefined) {
        const next = { ...await settings(), ...(indexes ? { indexes } : {}), ...(curatedOnly !== undefined ? { curatedOnly } : {}) }
        await writeJsonFile(settingsFile, next)
        if (indexes) listing = undefined
      }
      if (registry) {
        const file = join(baseDir, '.npmrc')
        const text = existsSync(file) ? await readFile(file, 'utf8') : ''
        const lines = text.split(/\r?\n/).filter((line) => !/^\s*registry\s*=/.test(line))
        const value = registry.replace(/\/?$/, '/')
        if (value !== DEFAULT_REGISTRY) lines.unshift(`registry=${value}`)
        await writeFile(file, lines.join('\n').replace(/\n*$/, '\n'))
        forgetRegistry(baseDir)
        logger.info('installs now use %s', value)
      }
      const file = join(baseDir, '.npmrc')
      return { ...await settings(), registry: await registryUrl(baseDir), npmrc: existsSync(file) ? npmrcRegistry(await readFile(file, 'utf8')) : undefined }
    },
  })

  /** Checks that installing from here is possible, and says why not. */
  async function assertCanInstall() {
    if (!isApp()) throw new MushinError('conflict', DEVELOPMENT)
    if (!deps.link()) throw new MushinError('unavailable', NO_SUPERVISOR)
  }

  /**
   * Runs an install or uninstall in place when npm says it only adds or removes packages nobody has loaded;
   * otherwise hands it to the supervisor. Returns whether the app restarts for it.
   */
  async function change(plan: Pick<UpgradePlan, 'kind' | 'packages' | 'remove'>, untouched: (name: string) => boolean) {
    const pm = appPackageManager(baseDir)
    const [command, args] = plan.remove?.length ? uninstallCommand(pm, plan.remove) : installCommand(pm, plan.packages)
    const preview = plan.packages.length && plan.remove?.length ? undefined : await previewInstall(baseDir, [...args])
    const inPlace = changesInPlace(preview, untouched)
    if (!inPlace) {
      const started = await deps.startPlan(plan)
      return { restart: true, time: started.time }
    }
    let output = ''
    await run(command, args, baseDir, { output: (chunk) => (output += chunk) }).catch((error: Error) => {
      throw new MushinError('failed', `${error.message}\n${output.slice(-2000)}`)
    })
    await manager().graph(true)
    deps.afterChange()
    return { restart: false, time: Date.now(), added: preview.added, removed: preview.removed }
  }

  ctx.actions.define({
    name: 'plugins.install',
    description: 'Install a plugin from the plugin market, at the newest version that runs on this Mushin.js, with the plugins it needs. A package that changes nothing already installed goes in while Mushin.js runs; otherwise Mushin.js restarts for it and goes back if the install fails. Turn it on afterwards with plugins.enable.',
    risk: 'dangerous',
    input: z.object({
      name: z.string(),
      version: z.string().optional().describe('A version from market.package; the newest that runs here by default'),
    }),
    handler: async ({ name, version }) => {
      await assertCanInstall()
      const [value, have, config] = await Promise.all([current(), installed(), settings()])
      const specs = planInstall(value.entries, name, { version, installed: (item) => have.has(item), mushinVersion: MUSHIN_VERSION, curatedOnly: config.curatedOnly })
      logger.info('installing %s', specs.join(' '))
      return { packages: specs, ...await change({ kind: 'install', packages: specs }, () => false) }
    },
  })

  ctx.actions.define({
    name: 'plugins.uninstall',
    description: 'Uninstall a third-party plugin package: its entries are turned off and taken out of the config first (refused while other enabled plugins need it), then the package is removed. Official plugins that come with Mushin.js cannot be uninstalled, only turned off.',
    risk: 'dangerous',
    input: z.object({ name: z.string() }),
    handler: async ({ name }) => {
      await assertCanInstall()
      const have = await installed()
      const mine = have.get(name)
      if (!mine) throw new MushinError('not_found', `${name} is not installed`)
      if (mine.local) throw new MushinError('conflict', `${name} is a local plugin folder; remove the folder instead`)
      if (mine.builtin || !mine.ownDependency) throw new MushinError('forbidden', `${name} comes with Mushin.js and cannot be uninstalled; turn it off instead`)
      const plugins = manager()
      for (const entry of plugins.entries.filter((item) => item.package === name)) await plugins.remove(entry.id)
      logger.info('uninstalling %s', name)
      // Its own code no longer runs, so removing its files is safe; anything else changing needs the supervisor.
      return { removed: name, ...await change({ kind: 'uninstall', packages: [], remove: [name] }, (pkg) => pkg === name || !have.has(pkg)) }
    },
  })
}
