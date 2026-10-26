import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const vite = await createServer({ root: fileURLToPath(new URL('../../dashboard', import.meta.url)) })
await vite.listen()
vite.printUrls()

const url = vite.resolvedUrls?.local[0] ?? vite.resolvedUrls?.network[0]
if (!url) throw new Error('Vite did not resolve a dashboard URL')
process.env.MUSHIN_DEV_DASHBOARD = url.replace(/\/$/, '')
await import('./cli')
