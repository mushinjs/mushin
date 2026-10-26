import { manifestProblems, undeclaredServices } from '@mushin/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance

beforeAll(async () => {
  app = await startInstance()
})

afterAll(async () => {
  await app?.stop()
})

const status = async (id: string) => (await app.call<any[]>('plugins.list')).find((plugin) => plugin.id === id)?.status

describe('plugin dependencies', () => {
  it('declares in every built-in manifest the plugins behind the services it injects', async () => {
    const graph = await app.ctx.manager.graph()
    const builtin = graph.catalog.filter((entry) => entry.package.startsWith('@mushin/'))
    expect(builtin.length).toBeGreaterThan(10)
    for (const entry of builtin) {
      expect(manifestProblems(entry.manifest), entry.package).toEqual([])
      const plugin = await app.ctx.manager.loadPlugin(entry.package)
      expect(undeclaredServices(graph, entry.package, plugin), entry.package).toEqual([])
    }
  })

  it('reports what a plugin needs and what needs it', async () => {
    const report = await app.call('plugins.dependencies', { package: '@mushin/plugin-flows' })
    expect(report.requires.map((dep: any) => dep.package)).toEqual(['@mushin/plugin-storage'])
    expect(report.dependents).toEqual(expect.arrayContaining([
      expect.objectContaining({ package: '@mushin/bot-plugin-flows', kind: 'bot', optional: false }),
      expect.objectContaining({ package: '@mushin/plugin-demo', optional: false }),
    ]))
    expect(report.disable.botPlugins).toContain('@mushin/bot-plugin-flows')
  })

  it('enables the disabled plugins a plugin requires only when asked to', async () => {
    await app.call('plugins.disable', { id: 'flows' })
    await expect(app.call('plugins.enable', { package: '@mushin/plugin-demo' })).rejects.toMatchObject({
      code: 'conflict',
      details: { plan: { enable: ['@mushin/plugin-flows'] } },
    })
    await app.call('plugins.enable', { package: '@mushin/plugin-demo', cascade: true })
    await waitFor(async () => (await status('flows')) === 'active' && (await status('demo')) === 'active')
  })

  it('disables the plugins that require one only when asked to', async () => {
    await expect(app.call('plugins.disable', { id: 'flows' })).rejects.toMatchObject({
      code: 'conflict',
      details: { plan: { disable: [{ id: 'demo', package: '@mushin/plugin-demo' }] } },
    })
    await app.call('plugins.disable', { id: 'flows', cascade: true })
    expect(await status('flows')).toBe('disabled')
    expect(await status('demo')).toBe('disabled')
    await app.call('plugins.enable', { package: '@mushin/plugin-flows' })
    await waitFor(async () => (await status('flows')) === 'active')
  })

  it('refuses a plugin whose requirements are not installed', async () => {
    const graph = await app.ctx.manager.graph()
    graph.catalog.push({ package: 'mushin-plugin-needy', version: '1.0.0', path: '/nowhere', local: true, manifest: { kind: 'app', requires: { plugins: { 'mushin-plugin-ghost': '^1.0.0' } } } })
    await expect(app.call('plugins.enable', { package: 'mushin-plugin-needy' })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('mushin-plugin-ghost') })
    graph.catalog.pop()
  })
})
