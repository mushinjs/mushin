import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockNapCat } from './helpers/mock-napcat'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let napcat: Awaited<ReturnType<typeof createMockNapCat>>
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let botId: string

beforeAll(async () => {
  llm = await createMockOpenAI()
  llm.setFallback({ text: 'pong from the model' })
  napcat = await createMockNapCat()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
  const bot = await app.call('bots.create', { name: 'Counter', adapter: { type: 'onebot', config: { mode: 'forward', url: napcat.url } } })
  botId = bot.id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
  await app.call('flows.create', {
    name: 'Ping',
    bots: [botId],
    nodes: [
      { id: 'cmd', type: 'trigger.command', config: { name: 'ping' } },
      { id: 'ask', type: 'ai.chat', inputs: { prompt: '{{sys.text}}' } },
      { id: 'say', type: 'action.reply', inputs: { text: '{{ask.reply}}' } },
    ],
    edges: [
      { source: 'cmd', sourceHandle: 'exec:next', target: 'ask', targetHandle: 'exec' },
      { source: 'ask', sourceHandle: 'exec:next', target: 'say', targetHandle: 'exec' },
    ],
  })
})

afterAll(async () => {
  await app?.stop()
  await napcat?.close()
  await llm?.close()
})

describe('statistics', () => {
  it('counts messages, commands, flow runs and model usage', async () => {
    napcat.pushGroupMessage('500', '42', [{ type: 'text', data: { text: '/ping' } }])
    napcat.pushGroupMessage('500', '43', [{ type: 'text', data: { text: 'hello' } }])
    await waitFor(async () => (await app.call('stats.overview')).today.sent === 1)
    const overview = await app.call('stats.overview')
    expect(overview).toMatchObject({
      bots: { online: 1, total: 1 },
      flows: { total: 1, withErrors: 0 },
      commands: 2,
      providers: { total: 1, passed: 0 },
      today: { received: 2, sent: 1, commands: 1, flowRuns: 1, llmCalls: 1 },
      versions: { node: process.version, mushin: expect.any(String), cordis: expect.any(String) },
    })
    expect(overview.dataBytes).toBeGreaterThan(0)

    const series = await app.call('stats.series', { metric: 'messages', hours: 24 })
    expect(series.points).toHaveLength(24)
    expect(series.series).toEqual([{ key: botId, name: 'Counter' }])
    expect(series.points.at(-1).values[botId]).toBe(3)

    const users = await app.call('stats.top', { dimension: 'users', days: 1 })
    expect(users).toHaveLength(2)
    expect(users[0]).toMatchObject({ botId, bot: 'Counter', count: 1 })
    expect(await app.call('stats.top', { dimension: 'commands', days: 1 })).toEqual([expect.objectContaining({ name: '/ping', count: 1 })])
    expect(await app.call('stats.top', { dimension: 'flows', days: 7 })).toEqual([expect.objectContaining({ name: 'Ping', count: 1, errors: 0 })])
    expect(await app.call('stats.top', { dimension: 'llm', days: 1 })).toEqual([expect.objectContaining({ name: 'Mock · mock-model', count: 1 })])

    const week = await app.call('stats.series', { metric: 'flows', hours: 168 })
    expect(week.granularity).toBe('day')
    expect(week.points).toHaveLength(7)
    expect(week.points.at(-1).values.total).toBe(1)
  })
})
