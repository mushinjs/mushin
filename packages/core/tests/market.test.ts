import { describe, expect, it } from 'vitest'
import { chooseVersion, entryFromVersion, fetchPackageDetail, isMarketIndex, missingRequirements, searchRegistry } from '../src/market'
import type { Fetch } from '../src/packages'

const REGISTRY = 'https://registry.test/'

function registry(routes: Record<string, unknown>) {
  const asked: string[] = []
  const fetcher: Fetch = async (url) => {
    asked.push(url)
    const path = url.slice(REGISTRY.length)
    const key = Object.keys(routes).find((route) => path === route || path.startsWith(`${route}?`) || (route.endsWith('*') && path.startsWith(route.slice(0, -1))))
    return key ? { ok: true, status: 200, json: async () => routes[key] } : { ok: false, status: 404, json: async () => ({}) }
  }
  return { fetcher, asked }
}

describe('chooseVersion', () => {
  const entry = {
    version: '2.0.0',
    versions: [
      { version: '2.0.0', mushin: '>=0.5.0' },
      { version: '1.2.0', mushin: '>=0.3.0', deprecated: true },
      { version: '1.1.0', mushin: '>=0.3.0' },
      { version: '1.0.0' },
    ],
  }

  it('takes the newest version that runs here, skipping deprecated ones', () => {
    expect(chooseVersion(entry, '0.5.1')).toEqual({ version: '2.0.0', latest: '2.0.0' })
    expect(chooseVersion(entry, '0.4.0')).toEqual({ version: '1.1.0', latest: '2.0.0' })
  })

  it('says what the latest needs when nothing runs here', () => {
    expect(chooseVersion({ version: '3.0.0', versions: [{ version: '3.0.0', mushin: '>=1.0.0' }] }, '0.4.0')).toEqual({ latest: '3.0.0', needs: '>=1.0.0' })
    expect(chooseVersion({ version: '1.0.0', requires: { mushin: '>=0.2.0' } }, '0.4.0')).toEqual({ version: '1.0.0', latest: '1.0.0' })
  })
})

describe('the market from npm', () => {
  it('reads every package with the keyword, with the manifest of its latest version', async () => {
    const { fetcher, asked } = registry({
      '-/v1/search': {
        objects: [
          { package: { name: 'mushin-plugin-weather', version: '1.0.0', date: '2026-11-20T00:00:00Z', publisher: { username: 'GitHub Actions', trustedPublisher: { id: 'github' } } }, downloads: { weekly: 42 } },
          { package: { name: 'mushin-plugin-old', version: '0.1.0' } },
          { package: { name: 'not-a-plugin', version: '1.0.0' } },
          { package: { name: '@mushinjs/plugin-demo', version: '0.4.0' } },
        ],
      },
      'mushin-plugin-weather/latest': {
        name: 'mushin-plugin-weather', version: '1.0.0', license: 'MIT', repository: { url: 'git+https://github.com/a/weather.git' },
        mushin: { kind: 'app', category: 'feature', displayName: { en: 'Weather', 'zh-CN': '天气' }, requires: { mushin: '>=0.4.0', plugins: { '@mushinjs/plugin-bots': '*' } } },
      },
      'mushin-plugin-old/latest': { name: 'mushin-plugin-old', version: '0.1.0', deprecated: 'use weather', mushin: { kind: 'app' } },
      'not-a-plugin/latest': { name: 'not-a-plugin', version: '1.0.0' },
      '@mushinjs%2Fplugin-demo/latest': { name: '@mushinjs/plugin-demo', version: '0.4.0', mushin: { kind: 'app', category: 'example' } },
    })
    const entries = await searchRegistry({ registry: REGISTRY, fetch: fetcher })
    expect(asked[0]).toBe(`${REGISTRY}-/v1/search?text=keywords:mushin-plugin&size=250&from=0`)
    expect(entries.map((entry) => entry.name)).toEqual(['mushin-plugin-weather', '@mushinjs/plugin-demo'])
    expect(entries[0]).toMatchObject({
      kind: 'app', category: 'feature', version: '1.0.0', downloads: 42, trusted: true, official: false, license: 'MIT',
      repository: 'https://github.com/a/weather', displayName: { 'zh-CN': '天气' }, versions: [{ version: '1.0.0', mushin: '>=0.4.0' }],
    })
    expect(entries[1]).toMatchObject({ official: true, trusted: false })
  })

  it('reads a package\'s versions and README for its details', async () => {
    const { fetcher } = registry({
      'mushin-plugin-weather': {
        'dist-tags': { latest: '1.1.0' },
        readme: '# Weather',
        time: { '1.0.0': '2026-01-01', '1.1.0': '2026-02-01' },
        versions: {
          '1.0.0': { name: 'mushin-plugin-weather', version: '1.0.0', mushin: { requires: { mushin: '>=0.3.0' } } },
          '1.1.0': { name: 'mushin-plugin-weather', version: '1.1.0', mushin: { requires: { mushin: '>=0.4.0' } } },
        },
      },
    })
    const detail = await fetchPackageDetail('mushin-plugin-weather', { registry: REGISTRY, fetch: fetcher })
    expect(detail.versions).toEqual([{ version: '1.1.0', mushin: '>=0.4.0', time: '2026-02-01' }, { version: '1.0.0', mushin: '>=0.3.0', time: '2026-01-01' }])
    expect(detail.readme).toBe('# Weather')
    expect(detail.latest?.version).toBe('1.1.0')
  })

  it('turns a version document without a manifest into nothing', () => {
    expect(entryFromVersion({ name: 'x', version: '1.0.0' })).toBeUndefined()
  })
})

describe('index and requirements', () => {
  it('knows an index it can read', () => {
    expect(isMarketIndex({ format: 1, generatedAt: '', packages: [{ name: 'a', version: '1.0.0', kind: 'app' }] })).toBe(true)
    expect(isMarketIndex({ format: 2, packages: [] })).toBe(false)
    expect(isMarketIndex({ format: 1, packages: [{ name: 'a' }] })).toBe(false)
  })

  it('lists the required plugins an install brings along', () => {
    const installed = new Set(['@mushinjs/plugin-bots'])
    expect(missingRequirements({ requires: { plugins: { '@mushinjs/plugin-bots': '*', 'mushin-plugin-geo': '^1', '@cordisjs/plugin-server': '*' } } }, (name) => installed.has(name))).toEqual(['mushin-plugin-geo'])
  })
})
