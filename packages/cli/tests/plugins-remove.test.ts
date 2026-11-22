import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance

beforeAll(async () => {
  app = await startInstance()
})

afterAll(async () => {
  await app?.stop()
})

const list = () => app.call<any[]>('plugins.list')
const saved = async () => JSON.parse(await readFile(join(app.baseDir, 'mushin.config.json'), 'utf8')).plugins as any[]

describe('removing app plugin entries', () => {
  it('shows an entry whose package is gone as failed, and removes it', async () => {
    app.ctx.manager.entries.push({ id: 'gone', package: '@mushinjs/plugin-gone', enabled: true, config: { x: 1 } })
    await expect(app.call('plugins.reload', { id: 'gone' })).rejects.toThrow()
    expect((await list()).find((plugin) => plugin.id === 'gone')).toMatchObject({ status: 'failed', error: '@mushinjs/plugin-gone is not installed' })

    expect(await app.call('plugins.remove', { id: 'gone' })).toEqual({ id: 'gone', package: '@mushinjs/plugin-gone' })
    expect((await list()).map((plugin) => plugin.id)).not.toContain('gone')
    expect((await saved()).map((entry) => entry.id)).not.toContain('gone')
  })

  it('stops a running plugin before removing it, and it can be enabled again', async () => {
    await app.call('plugins.configure', { id: 'stats', config: {} })
    await app.call('plugins.remove', { id: 'stats' })
    expect((await saved()).some((entry) => entry.package === '@mushinjs/plugin-stats')).toBe(false)
    expect((await list()).some((plugin) => plugin.package === '@mushinjs/plugin-stats' && plugin.id)).toBe(false)

    await app.call('plugins.enable', { package: '@mushinjs/plugin-stats' })
    await waitFor(async () => (await list()).find((plugin) => plugin.package === '@mushinjs/plugin-stats')?.status === 'active')
  })

  it('keeps essential plugins', async () => {
    await expect(app.call('plugins.remove', { id: 'bots' })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await list()).map((plugin) => plugin.id)).toContain('bots')
  })
})
