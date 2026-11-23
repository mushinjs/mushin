import { register } from 'node:module'

/** The query that marks a local plugin's modules with the version of its files; the manager sets it on the entry file. */
export const VERSION_QUERY = 'mushin-v'

/**
 * Loader hooks for local plugins, which the manager imports with `?mushin-v=<n>` on their entry file:
 * - the files a plugin imports by relative path get the same query, so a reload after an edit runs the new code
 *   instead of the copies Node cached;
 * - packages it imports by name come from the app when its own folder has none, and the shared ones
 *   (`@mushinjs/*`, `cordis`, `@cordisjs/*`) always do, so a plugin in a folder outside the app runs against the
 *   same copy of Mushin.js as everything else.
 * Plain JavaScript in a data: URL, because hooks run in a thread of their own without tsx.
 */
const HOOKS = `
const VERSION = ${JSON.stringify(VERSION_QUERY)}
const SHARED = /^(?:@mushinjs\\/|@cordisjs\\/|cordis(?:\\/|$))/
let hosts = []
export function initialize(data) { hosts = data?.hosts ?? [] }
function versionOf(url) {
  if (!url || !url.startsWith('file:')) return
  const at = url.indexOf('?')
  return at < 0 ? undefined : new URLSearchParams(url.slice(at + 1)).get(VERSION) ?? undefined
}
async function fromHosts(specifier, context, next) {
  for (const parentURL of hosts) {
    try { return await next(specifier, { ...context, parentURL }) } catch {}
  }
}
export async function resolve(specifier, context, next) {
  const version = versionOf(context.parentURL)
  if (!version || specifier.startsWith('node:') || specifier.startsWith('data:')) return next(specifier, context)
  if (!/^(?:\\.{1,2}\\/|\\/|file:|#|[a-zA-Z]:[\\\\/])/.test(specifier)) {
    if (SHARED.test(specifier)) {
      const found = await fromHosts(specifier, context, next)
      if (found) return found
    }
    try {
      return await next(specifier, context)
    } catch (error) {
      const found = await fromHosts(specifier, context, next)
      if (found) return found
      throw error
    }
  }
  const result = await next(specifier, context)
  if (!result.url.startsWith('file:') || result.url.includes('/node_modules/')) return result
  const url = new URL(result.url)
  url.searchParams.set(VERSION, version)
  return { ...result, url: url.href }
}
`

let registered = false

/** Registers the hooks once per process; `hosts` are the file URLs packages are looked up from, in order. */
export function registerPluginHooks(hosts: string[]) {
  if (registered) return
  registered = true
  register(`data:text/javascript,${encodeURIComponent(HOOKS)}`, { data: { hosts } })
}
