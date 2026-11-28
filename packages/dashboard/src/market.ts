/**
 * The plugin market in the dashboard: the listing from the Updates plugin (plugin-market), installs and uninstalls,
 * and README rendering. Shared by the market tab and the details panel.
 */
import MarkdownIt from 'markdown-it'
import { reactive } from 'vue'
import { call } from './api'
import { highlightCode } from './components/fairy/markdown'
import type { LocalizedText } from './types'
import { updates, waitForApp } from './updates'

export interface MarketVersion {
  version: string
  mushin?: string
  time?: string
  deprecated?: boolean
}

export interface MarketItem {
  name: string
  displayName?: LocalizedText
  description?: LocalizedText
  kind: 'app' | 'bot'
  category?: string
  platforms?: string[]
  requires?: { mushin?: string; plugins?: Record<string, string> }
  optional?: { mushin?: string; plugins?: Record<string, string> }
  version: string
  next?: string
  versions?: MarketVersion[]
  downloads?: number
  updatedAt?: string
  license?: string
  repository?: string
  homepage?: string
  publisher?: string
  trusted?: boolean
  official?: boolean
  curated?: boolean
  readme?: string
  icon?: string
  keywords?: string[]
  /** The version that would be installed here, or what the latest needs. */
  choice: { version?: string; latest: string; needs?: string }
  installed?: { version: string; local: boolean; builtin: boolean; ownDependency: boolean }
  update?: string
  /** False when the picked-only setting keeps it out. */
  allowed: boolean
}

export interface MarketListing {
  source: 'index' | 'npm'
  url: string
  fetchedAt: number
  indexError?: string
  registry: string
  version: string
  mode: 'app' | 'development'
  supervised: boolean
  settings: { indexes: string[]; curatedOnly: boolean }
  entries: MarketItem[]
}

export interface MarketDetail extends MarketItem {
  brings: { name: string; version?: string; inMarket: boolean }[]
  detailError?: string
}

export const market = reactive({
  listing: undefined as MarketListing | undefined,
  loading: false,
  error: '',
})

let loaded: Promise<void> | undefined

export function loadMarket(refresh = false) {
  if (loaded && !refresh) return loaded
  market.loading = true
  loaded = call<MarketListing>('market.list', { refresh })
    .then((listing) => {
      market.listing = listing
      market.error = ''
    })
    .catch((error: Error) => {
      market.error = error.message
      loaded = undefined
    })
    .finally(() => (market.loading = false))
  return loaded
}

export const marketEntry = (name: string) => market.listing?.entries.find((entry) => entry.name === name)

/** Why the market cannot install here, or undefined when it can. */
export function installBlocker(listing: MarketListing | undefined): 'development' | 'supervisor' | undefined {
  if (!listing) return
  if (listing.mode !== 'app') return 'development'
  if (!listing.supervised) return 'supervisor'
}

/**
 * Installs a market package. Done in place, it resolves when the package is there; through the supervisor, the
 * restart overlay takes over until the app is back.
 */
export async function installPackage(name: string) {
  const result = await call<{ packages: string[]; restart: boolean; time: number }>('plugins.install', { name })
  if (result.restart) {
    updates.result = undefined
    updates.pending = { kind: 'install', time: result.time, packages: result.packages }
    void waitForApp()
  } else {
    await loadMarket(true)
  }
  return result
}

export async function uninstallPackage(name: string) {
  const result = await call<{ restart: boolean; time: number }>('plugins.uninstall', { name })
  if (result.restart) {
    updates.result = undefined
    updates.pending = { kind: 'uninstall', time: result.time, packages: [name] }
    void waitForApp()
  } else {
    await loadMarket(true)
  }
  return result
}

// ---- README ----

const md = new MarkdownIt({ html: false, linkify: true, highlight: (code, lang) => highlightCode(code, lang.toLowerCase()) })
const defaultLink = md.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]!.attrSet('target', '_blank')
  tokens[index]!.attrSet('rel', 'noopener noreferrer')
  return defaultLink(tokens, index, options, env, self)
}

/** A package's README as HTML; raw HTML in it is shown as text. */
export const renderReadme = (text: string) => md.render(text)
