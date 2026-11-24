import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance

beforeAll(async () => {
  app = await startInstance()
})

afterAll(async () => {
  await app?.stop()
})

describe('adding bots', () => {
  it('lists the sandbox adapter first, with the logos and descriptions of adapters', async () => {
    const adapters = await app.call<any[]>('bots.adapters')
    expect(adapters[0]).toMatchObject({ id: 'sandbox', icon: expect.any(String), description: expect.anything() })
    expect(adapters.find((item) => item.id === 'telegram')).toMatchObject({ icon: expect.any(String), color: expect.any(String) })
  })

  it('runs a sandbox bot with no account, answering only in its sandbox', async () => {
    const bot = await app.call('bots.create', { name: 'Try', adapter: { type: 'sandbox', config: {} }, plugins: [{ package: '@mushinjs/bot-plugin-echo' }] })
    await waitFor(async () => (await app.call('bots.get', { id: bot.id })).status === 'online')
    await app.call('bots.sandbox', { id: bot.id, text: 'echo hi' })
    const replies = await waitFor(async () => {
      const messages = await app.call<any[]>('bots.messages', { id: bot.id, channel: '@sandbox' })
      return messages.some((item) => item.direction === 'out') ? messages : undefined
    })
    expect(replies.some((item) => item.direction === 'out')).toBe(true)
  })

  it('saves a stopped bot whose connection is not filled in yet', async () => {
    const bot = await app.call('bots.create', { name: 'Later', adapter: { type: 'qq', config: {} }, enabled: false })
    expect(bot).toMatchObject({ enabled: false, status: 'offline' })
  })

  it('renames a running bot without restarting it', async () => {
    const bot = await app.call('bots.create', { name: 'Old', adapter: { type: 'sandbox', config: {} } })
    await waitFor(async () => (await app.call('bots.get', { id: bot.id })).status === 'online')
    await app.call('bots.update', { id: bot.id, name: 'New' })
    expect(await app.call('bots.get', { id: bot.id })).toMatchObject({ name: 'New', status: 'online' })
  })
})
