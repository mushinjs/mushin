import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize, sep } from 'node:path'

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
}

export function dashboardRoot() {
  try {
    const require = createRequire(import.meta.url)
    return join(dirname(require.resolve('@mushin/dashboard/package.json')), 'dist')
  } catch {
    return undefined
  }
}

export interface StaticFile {
  body: Buffer
  type: string
  immutable: boolean
}

/** Resolves a request path to a file under `root`; unknown paths fall back to index.html for the SPA router. */
export async function readStatic(root: string, path: string): Promise<StaticFile | undefined> {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return
  }
  const relative = normalize(decoded).replace(/^([/\\])+/, '')
  const file = join(root, relative)
  if (file !== root && !file.startsWith(root + sep)) return
  try {
    if ((await stat(file)).isFile()) {
      return {
        body: await readFile(file),
        type: types[extname(file)] ?? 'application/octet-stream',
        immutable: relative.startsWith('assets' + sep) || relative.startsWith('assets/'),
      }
    }
  } catch {}
  if (extname(relative)) return
  try {
    return { body: await readFile(join(root, 'index.html')), type: types['.html'], immutable: false }
  } catch {}
}

export const MISSING_BUILD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mushin.js</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 16px;line-height:1.6;color:#222}code{background:#f2f2f2;padding:2px 6px;border-radius:4px}</style>
</head><body><h1>Mushin.js is running</h1>
<p>The dashboard has not been built yet. Run <code>pnpm build</code> in the Mushin.js folder, or start the dev server with <code>pnpm dev</code>.</p>
</body></html>`
