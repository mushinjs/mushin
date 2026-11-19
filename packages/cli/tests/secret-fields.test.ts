import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { maskSecrets, restoreMasked } from '@mushinjs/core'
import { newPlugin } from '../src/scaffold'
import { startInstance, type TestInstance, TOKEN } from './helpers/instance'

const root = fileURLToPath(new URL('../../../node_modules/', import.meta.url))
const KEY = 'wx-secret-key-0123456789'
const temps: string[] = []
let app: TestInstance | undefined

afterEach(async () => {
  await app?.stop({ keep: true })
  app = undefined
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A local plugin with a secret field; its action tells whether it got the real key. */
async function instanceWithSecretPlugin(config: Record<string, unknown> = {}) {
  const baseDir = await mkdtemp(join(root, '.mushin-secret-'))
  temps.push(baseDir)
  await newPlugin(baseDir, 'weather')
  await writeFile(join(baseDir, 'plugins', 'weather', 'src', 'index.ts'), `import { type Context, field, z } from '@mushinjs/core'

export const name = 'weather'
export const inject = ['actions']
export const Config = z.object({
  city: z.string().default('Shanghai'),
  apiKey: z.string().default('').meta(field('API key', undefined, {}, { secret: true })),
})

export function apply(ctx: Context, raw: z.input<typeof Config>) {
  const config = Config.parse(raw ?? {})
  ctx.actions.define({
    name: 'weather.check',
    description: 'Whether the key arrived.',
    risk: 'read',
    input: z.object({ key: z.string() }),
    handler: ({ key }) => ({ ok: config.apiKey === key, city: config.city }),
  })
}
`)
  const file = join(baseDir, 'mushin.config.json')
  const saved = JSON.parse(await readFile(file, 'utf8'))
  saved.plugins.find((entry: any) => entry.id === 'weather').config = config
  await writeFile(file, JSON.stringify(saved, null, 2))
  return baseDir
}

const configText = (baseDir: string) => readFile(join(baseDir, 'mushin.config.json'), 'utf8')
const envText = (baseDir: string) => readFile(join(baseDir, '.env'), 'utf8').catch(() => '')

describe('secret plugin settings', () => {
  it('keeps a key typed into the dashboard in .env and shows it masked', async () => {
    const baseDir = await instanceWithSecretPlugin()
    app = await startInstance({ baseDir })
    await app.call('plugins.configure', { id: 'weather', config: { city: 'Beijing', apiKey: KEY } })

    expect(await configText(baseDir)).not.toContain(KEY)
    expect(await configText(baseDir)).toContain('${WEATHER_API_KEY}')
    expect(await envText(baseDir)).toContain(`WEATHER_API_KEY=${KEY}`)
    expect(await app.call('weather.check', { key: KEY })).toEqual({ ok: true, city: 'Beijing' })

    const entry = (await app.call<any[]>('plugins.list')).find((item) => item.id === 'weather')
    expect(entry.config).toEqual({ city: 'Beijing', apiKey: '${WEATHER_API_KEY}' })
    expect(entry.configSchema.properties.apiKey['x-secret']).toBe(true)

    // A form sends the masked value back unchanged: the key stays.
    await app.call('plugins.configure', { id: 'weather', config: { city: 'Tianjin', apiKey: '${WEATHER_API_KEY}' } })
    expect(await app.call('weather.check', { key: KEY })).toEqual({ ok: true, city: 'Tianjin' })
  })

  it('moves a key written into mushin.config.json by hand, and never shows it to MCP clients', async () => {
    const baseDir = await instanceWithSecretPlugin({ apiKey: KEY })
    app = await startInstance({ baseDir })
    expect(await app.call('weather.check', { key: KEY })).toMatchObject({ ok: true })
    expect(await configText(baseDir)).not.toContain(KEY)
    expect(await envText(baseDir)).toContain(KEY)

    const response = await fetch(`${app.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'plugins__list', arguments: {} } }),
    })
    const text = (await response.json() as any).result.content[0].text as string
    expect(text).toContain('weather')
    expect(text).not.toContain(KEY)
  })

  it('masks a plain key in the list until it is moved', () => {
    expect(maskSecrets({ apiKey: KEY, city: 'x' }, ['apiKey'])).toEqual({ apiKey: 'wx-…6789', city: 'x' })
    expect(maskSecrets({ apiKey: '${A}' }, ['apiKey'])).toEqual({ apiKey: '${A}' })
    expect(restoreMasked({ apiKey: 'wx-…6789' }, { apiKey: '${A}' }, ['apiKey'])).toEqual({ apiKey: '${A}' })
  })
})
