import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { demoBotReady, startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance
let botId: string

beforeAll(async () => {
  app = await startInstance()
  await app.call('plugins.enable', { package: '@mushinjs/plugin-demo' })
  await app.call('plugins.configure', { id: 'demo', config: { bot: true, flows: { command: true } } })
  botId = await waitFor(async () => (await app.call<any[]>('bots.list'))[0]?.id)
  await demoBotReady(app, botId)
})

afterAll(async () => {
  await app?.stop()
})

/** Sends as the test user and returns the record id of that message once the bot answered it. */
async function send(text: string) {
  const count = async () => (await app.call<any[]>('bots.messages', { id: botId, limit: 500 })).length
  const before = await count()
  await app.call('demo.say', { text })
  await waitFor(async () => (await count()) >= before + 2)
  const records = await app.call<any[]>('bots.messages', { id: botId, limit: 500 })
  return records.filter((record) => record.direction === 'in' && record.segments.some((s: any) => s.data?.text === text)).at(-1).id as string
}

describe('bot logs', () => {
  it('ties each line to the message being handled, and filters by message, text, level and time', async () => {
    const first = await send('/ping')
    const second = await send('/echo hello')

    const ofFirst = await waitFor(async () => {
      const lines = await app.call<any[]>('bots.logs', { id: botId, message: first })
      return lines.some((line) => line.text.includes('processed in')) ? lines : undefined
    })
    expect(ofFirst.every((line) => line.message === first)).toBe(true)
    expect(ofFirst.some((line) => line.text.includes('received from') && line.text.includes('/ping'))).toBe(true)
    expect(ofFirst.some((line) => line.text.includes('/echo'))).toBe(false)

    const echo = await app.call<any[]>('bots.logs', { id: botId, query: 'ECHO HELLO' })
    expect(echo.length).toBeGreaterThan(0)
    expect(echo.every((line) => line.text.toLowerCase().includes('echo hello'))).toBe(true)
    expect(echo.some((line) => line.message === second)).toBe(true)

    const warnings = await app.call<any[]>('bots.logs', { id: botId, level: 'warn' })
    expect(warnings.every((line) => line.type === 'warn' || line.type === 'error')).toBe(true)

    const now = Date.now()
    expect((await app.call<any[]>('bots.logs', { id: botId, since: now - 60_000, until: new Date(now + 1000).toISOString() })).length).toBeGreaterThan(0)
    expect(await app.call<any[]>('bots.logs', { id: botId, since: now + 60_000 })).toEqual([])
    await expect(app.call('bots.logs', { id: botId, since: 'not a time' })).rejects.toThrow(/not a time/)
  })
})
