import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkUpdates, type Fetch, installCommand, isNewer, updateCount } from '../src/packages'

const REGISTRY = 'https://registry.test/'

/** A registry with these packages: name → dist-tags, and the `mushin` manifests of versions. */
function registry(packages: Record<string, { tags: Record<string, string>; manifests?: Record<string, unknown> }>) {
  const asked: { url: string; accept?: string }[] = []
  const fetcher: Fetch = async (url, init) => {
    asked.push({ url, accept: init?.headers?.accept })
    const path = decodeURIComponent(url.slice(REGISTRY.length))
    const [name, version] = path.startsWith('@') ? [path.split('/').slice(0, 2).join('/'), path.split('/')[2]] : path.split('/')
    const pkg = packages[name!]
    if (!pkg) return { ok: false, status: 404, json: async () => ({}) }
    if (version) return { ok: true, status: 200, json: async () => ({ version, mushin: pkg.manifests?.[version] }) }
    return { ok: true, status: 200, json: async () => ({ 'dist-tags': pkg.tags, versions: Object.fromEntries(Object.values(pkg.tags).map((v) => [v, {}])) }) }
  }
  return { fetcher, asked }
}

async function app(deps: Record<string, string>, installed: Record<string, { version: string; mushin?: unknown }> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mushin-packages-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: deps }))
  for (const [name, pkg] of Object.entries(installed)) {
    await mkdir(join(dir, 'node_modules', name), { recursive: true })
    await writeFile(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, ...pkg }))
  }
  return dir
}

describe('checkUpdates', () => {
  it('reports one Mushin.js version for every official package, on the channel of the running version', async () => {
    const baseDir = await app({ '@mushinjs/cli': '^0.3.0', '@mushinjs/core': '^0.3.0' })
    const { fetcher, asked } = registry({ '@mushinjs/cli': { tags: { latest: '0.4.0', next: '0.4.1-next.1' } } })
    const report = await checkUpdates({ baseDir, version: '0.3.0', fetch: fetcher, registry: REGISTRY, notes: async () => 'Notes', now: () => 1 })
    expect(report).toMatchObject({
      mode: 'app',
      checkedAt: 1,
      mushin: { current: '0.3.0', available: '0.4.0', channel: 'latest', packages: ['@mushinjs/cli', '@mushinjs/core'], notes: 'Notes', notesUrl: expect.stringContaining('/releases/tag/v0.4.0') },
      plugins: [],
    })
    expect(asked[0]).toEqual({ url: `${REGISTRY}@mushinjs%2Fcli`, accept: 'application/vnd.npm.install-v1+json' })
    expect(updateCount(report)).toBe(1)
  })

  it('follows next for a preview, and a newer release over an older preview', async () => {
    const baseDir = await app({ '@mushinjs/cli': 'next' })
    const { fetcher } = registry({ '@mushinjs/cli': { tags: { latest: '0.4.0', next: '0.4.0-next.5' } } })
    const preview = await checkUpdates({ baseDir, version: '0.4.0-next.3', fetch: fetcher, registry: REGISTRY })
    expect(preview.mushin).toMatchObject({ channel: 'next', available: '0.4.0' })
    const pinned = await checkUpdates({ baseDir, version: '0.4.0', channel: 'next', fetch: fetcher, registry: REGISTRY })
    expect(pinned.mushin?.available).toBeUndefined()
  })

  it('checks third-party plugins one by one, with whether they run on this version', async () => {
    const baseDir = await app(
      { '@mushinjs/cli': '^0.3.0', 'mushin-plugin-weather': '^1.0.0', 'mushin-plugin-old': '^2.0.0', lodash: '^4.0.0' },
      {
        'mushin-plugin-weather': { version: '1.0.0', mushin: { kind: 'app' } },
        'mushin-plugin-old': { version: '2.0.0', mushin: { kind: 'app' } },
        'mushin-plugin-extra': { version: '0.1.0', mushin: { kind: 'app' } },
        lodash: { version: '4.0.0' },
      },
    )
    const { fetcher } = registry({
      '@mushinjs/cli': { tags: { latest: '0.3.0' } },
      'mushin-plugin-weather': { tags: { latest: '1.2.0' }, manifests: { '1.2.0': { requires: { mushin: '>=0.3.0' } } } },
      'mushin-plugin-old': { tags: { latest: '3.0.0' }, manifests: { '3.0.0': { requires: { mushin: '>=0.5.0' } } } },
    })
    const report = await checkUpdates({ baseDir, version: '0.3.0', fetch: fetcher, registry: REGISTRY, extraPackages: ['mushin-plugin-extra'] })
    expect(report.mushin?.available).toBeUndefined()
    expect(report.plugins).toEqual([
      { package: 'mushin-plugin-extra', current: '0.1.0', compatible: true, error: expect.stringContaining('404') },
      { package: 'mushin-plugin-old', current: '2.0.0', available: '3.0.0', compatible: false, requires: '>=0.5.0' },
      { package: 'mushin-plugin-weather', current: '1.0.0', available: '1.2.0', compatible: true, requires: '>=0.3.0' },
    ])
    expect(updateCount(report)).toBe(2)
  })

  it('treats an app without official dependencies as the repository: development mode', async () => {
    const baseDir = await app({ cordis: '^4.0.0' })
    const report = await checkUpdates({ baseDir, version: '0.3.0', fetch: async () => { throw new Error('no network expected') }, registry: REGISTRY })
    expect(report.mode).toBe('development')
    expect(updateCount(report)).toBe(0)
  })

  it('keeps going when the registry cannot be reached', async () => {
    const baseDir = await app({ '@mushinjs/cli': '^0.3.0' })
    const report = await checkUpdates({ baseDir, version: '0.3.0', fetch: async () => { throw new Error('offline') }, registry: REGISTRY })
    expect(report).toMatchObject({ mode: 'app', error: 'offline', plugins: [] })
  })
})

describe('versions and commands', () => {
  it('compares versions, previews before releases', () => {
    expect(isNewer('0.4.0', '0.3.0')).toBe(true)
    expect(isNewer('0.4.0-next.1', '0.4.0')).toBe(false)
    expect(isNewer('0.4.0', '0.4.0-next.9')).toBe(true)
    expect(isNewer(undefined, '0.3.0')).toBe(false)
  })

  it('installs exact versions', () => {
    expect(installCommand('npm', ['@mushinjs/cli@0.4.0'])).toEqual(['npm', ['install', '@mushinjs/cli@0.4.0']])
    expect(installCommand('pnpm', ['a@1.0.0'])).toEqual(['pnpm', ['add', 'a@1.0.0']])
  })
})
