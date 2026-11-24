import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance

beforeAll(async () => {
  app = await startInstance()
  await app.call('plugins.enable', { package: '@mushinjs/plugin-demo' })
})

afterAll(async () => {
  await app?.stop()
})

describe('adding bots', () => {
  it('lists adapters by their order, with their logos and descriptions', async () => {
    const adapters = await app.call<any[]>('bots.adapters')
    expect(adapters.find((item) => item.id === 'telegram')).toMatchObject({ icon: expect.any(String), color: expect.any(String), description: expect.anything() })
    expect(adapters.find((item) => item.id === 'onebot')?.icon).toMatch(/^data:image\/png;base64,/)
    expect(adapters[0]).toMatchObject({ id: 'demo', icon: expect.any(String) })
  })

  it('saves a stopped bot whose connection is not set up yet', async () => {
    const bot = await app.call('bots.create', { name: 'Later', adapter: { type: 'qq', config: {} }, enabled: false })
    expect(bot).toMatchObject({ enabled: false, status: 'offline' })
  })

  it('renames a running bot without restarting it', async () => {
    const bot = await app.call('bots.create', { name: 'Old', adapter: { type: 'demo', config: { greet: false } } })
    await waitFor(async () => (await app.call('bots.get', { id: bot.id })).status === 'online')
    await app.call('bots.update', { id: bot.id, name: 'New' })
    expect(await app.call('bots.get', { id: bot.id })).toMatchObject({ name: 'New', status: 'online' })
  })
})
