/**
 * The plugin market: the index format the dashboard reads (published by the mushinjs/market repository, whose
 * generator keeps a copy of these types), and the same entries worked out straight from the npm registry when no
 * index can be read. Which version of a plugin runs on this Mushin.js comes from its `mushin.requires.mushin`.
 */
import type { LocalizedText } from './manifest'
import { type Fetch, isNewer } from './packages'
import { satisfies } from './semver'

/** The keyword every Mushin.js plugin package carries. */
export const MARKET_KEYWORD = 'mushin-plugin'

/** The index the dashboard reads first; mirrors can be added in the market settings. */
export const DEFAULT_MARKET_INDEXES = ['https://mushinjs.github.io/market/index.json']

/** A registry mirror people in China often use. */
export const NPMMIRROR_REGISTRY = 'https://registry.npmmirror.com/'

/** One published version, with the Mushin.js versions it runs on. */
export interface MarketVersion {
  version: string
  /** Its `mushin.requires.mushin` range. */
  mushin?: string
  time?: string
  deprecated?: boolean
}

/** One plugin package in the market. */
export interface MarketEntry {
  name: string
  displayName?: LocalizedText
  description?: LocalizedText
  kind: 'app' | 'bot'
  category?: string
  platforms?: string[]
  requires?: { mushin?: string; plugins?: Record<string, string> }
  optional?: { mushin?: string; plugins?: Record<string, string> }
  /** The latest version. */
  version: string
  /** The `next` dist-tag, when newer than latest. */
  next?: string
  /** Recent versions, newest first, for picking one that runs on this Mushin.js. */
  versions?: MarketVersion[]
  /** Downloads in the last week. */
  downloads?: number
  /** When the latest version was published. */
  updatedAt?: string
  license?: string
  repository?: string
  homepage?: string
  /** Who published the latest version (an npm user, or "GitHub Actions" with trusted publishing). */
  publisher?: string
  /** Published from a CI workflow with npm Trusted Publishing, so the code matches its repository. */
  trusted?: boolean
  /** An `@mushinjs/*` package. */
  official?: boolean
  /** On the market's picked list. */
  curated?: boolean
  /** The start of its README, in Markdown. */
  readme?: string
  /** An icon: an image address, or the inside of a 24×24 SVG. */
  icon?: string
  keywords?: string[]
}

export interface MarketIndex {
  /** The format version; this file reads 1. */
  format: 1
  generatedAt: string
  packages: MarketEntry[]
}

/** Whether a document is a market index this version can read. */
export function isMarketIndex(value: unknown): value is MarketIndex {
  const index = value as MarketIndex
  return !!index && typeof index === 'object' && index.format === 1 && Array.isArray(index.packages)
    && index.packages.every((entry) => entry && typeof entry.name === 'string' && typeof entry.version === 'string')
}

// ---- which version runs here ----

export interface VersionChoice {
  /** The newest version that runs on this Mushin.js, if any. */
  version?: string
  /** The latest version, when it is not the one chosen. */
  latest: string
  /** The range the latest version needs, when no version runs here. */
  needs?: string
}

/** The newest version of an entry that runs on `mushinVersion`; deprecated versions are left out. */
export function chooseVersion(entry: Pick<MarketEntry, 'version' | 'versions' | 'requires'>, mushinVersion: string): VersionChoice {
  const versions: MarketVersion[] = entry.versions?.length ? entry.versions : [{ version: entry.version, mushin: entry.requires?.mushin }]
  const usable = versions.filter((item) => !item.deprecated).sort((a, b) => (isNewer(a.version, b.version) ? -1 : isNewer(b.version, a.version) ? 1 : 0))
  const fits = usable.find((item) => !item.mushin || satisfies(mushinVersion, item.mushin))
  if (fits) return { version: fits.version, latest: entry.version }
  return { latest: entry.version, needs: versions.find((item) => item.version === entry.version)?.mushin ?? entry.requires?.mushin }
}

// ---- straight from npm ----

/** A package.json of a published version, as far as the market reads it. */
interface VersionDoc {
  name: string
  version: string
  description?: string
  license?: string
  repository?: string | { url?: string }
  homepage?: string
  keywords?: string[]
  deprecated?: string
  mushin?: Partial<MarketEntry> & { kind?: 'app' | 'bot' }
  _npmUser?: { name?: string }
}

/** One result of the registry's search endpoint. */
interface SearchObject {
  package: { name: string; version: string; description?: string; date?: string; publisher?: { username?: string; trustedPublisher?: unknown }; links?: { repository?: string; homepage?: string } }
  downloads?: { weekly?: number }
}

const repoUrl = (repository: VersionDoc['repository']) => {
  const url = typeof repository === 'string' ? repository : repository?.url
  return url?.replace(/^git\+/, '').replace(/\.git$/, '')
}

/** A market entry from a package's version document (and its search result, for downloads and the publisher). */
export function entryFromVersion(doc: VersionDoc, found?: SearchObject): MarketEntry | undefined {
  const manifest = doc.mushin
  if (!manifest || doc.deprecated) return undefined
  const kind = manifest.kind === 'bot' ? 'bot' : 'app'
  const publisher = found?.package.publisher
  return {
    name: doc.name,
    displayName: manifest.displayName,
    description: manifest.description ?? doc.description,
    kind,
    category: manifest.category,
    platforms: manifest.platforms,
    requires: manifest.requires,
    optional: manifest.optional,
    version: doc.version,
    versions: [{ version: doc.version, mushin: manifest.requires?.mushin }],
    downloads: found?.downloads?.weekly,
    updatedAt: found?.package.date,
    license: doc.license,
    repository: repoUrl(doc.repository) ?? found?.package.links?.repository,
    homepage: doc.homepage ?? found?.package.links?.homepage,
    publisher: publisher?.username ?? doc._npmUser?.name,
    trusted: !!publisher?.trustedPublisher,
    official: doc.name.startsWith('@mushinjs/'),
    keywords: doc.keywords,
    icon: typeof manifest.icon === 'string' ? manifest.icon : undefined,
  }
}

const base = (registry: string) => registry.replace(/\/?$/, '/')
const encode = (name: string) => name.replace('/', '%2F')

async function getJson(fetcher: Fetch, url: string) {
  const response = await fetcher(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

/**
 * The market worked out from the registry: every package with the `mushin-plugin` keyword, with the `mushin`
 * manifest of its latest version (search results do not carry it). Deprecated packages are left out.
 */
export async function searchRegistry(options: { registry: string; fetch?: Fetch; limit?: number }): Promise<MarketEntry[]> {
  const fetcher = options.fetch ?? (fetch as Fetch)
  const registry = base(options.registry)
  const found: SearchObject[] = []
  const size = 250
  for (let from = 0; from < (options.limit ?? 1000); from += size) {
    const page = await getJson(fetcher, `${registry}-/v1/search?text=keywords:${MARKET_KEYWORD}&size=${size}&from=${from}`)
    const objects = (page.objects ?? []) as SearchObject[]
    found.push(...objects)
    if (objects.length < size) break
  }
  const entries = await Promise.all(found.map(async (item) => {
    try {
      const doc = await getJson(fetcher, `${registry}${encode(item.package.name)}/latest`) as VersionDoc
      return entryFromVersion(doc, item)
    } catch {
      return undefined
    }
  }))
  return entries.filter((entry): entry is MarketEntry => !!entry)
}

/** The full registry document of a package: every version with its range, the dist-tags, and the README. */
export async function fetchPackageDetail(name: string, options: { registry: string; fetch?: Fetch }) {
  const doc = await getJson(options.fetch ?? (fetch as Fetch), `${base(options.registry)}${encode(name)}`)
  const versions: MarketVersion[] = Object.values<VersionDoc>(doc.versions ?? {})
    .map((item) => ({ version: item.version, mushin: item.mushin?.requires?.mushin, time: doc.time?.[item.version], ...(item.deprecated ? { deprecated: true } : {}) }))
    .sort((a, b) => (isNewer(a.version, b.version) ? -1 : 1))
  const tags = (doc['dist-tags'] ?? {}) as Record<string, string>
  const latest = doc.versions?.[tags.latest] as VersionDoc | undefined
  return { versions, tags, readme: typeof doc.readme === 'string' ? doc.readme : undefined, latest }
}

/** The plugins an entry needs that are not installed, which an install brings along. */
export function missingRequirements(entry: Pick<MarketEntry, 'requires'>, installed: (name: string) => boolean) {
  return Object.keys(entry.requires?.plugins ?? {}).filter((name) => !installed(name) && name !== '@cordisjs/plugin-server')
}
