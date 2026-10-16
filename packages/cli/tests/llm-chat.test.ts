import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockNapCat } from './helpers/mock-napcat'
import { createMockOpenAI } from './helpers/mock-openai'

const PLUGIN = '@mushin/bot-plugin-llm-chat'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let napcat: Awaited<ReturnType<typeof createMockNapCat>>
let botId: string

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const usageFile = () => join(app.baseDir, 'data', 'llm-chat', `${botId}.json`)
const notices = (text: string) => napcat.sent.filter((call) => call.params?.message?.[0]?.data?.text === text).length

/** Replaces the plugin config (guardrails off unless set) and, unless `keepUsage`, clears today's usage. */
async function configure(config: Record<string, unknown>, keepUsage = false) {
  if (!keepUsage) await rm(usageFile(), { force: true })
  await app.call('bots.plugins.configure', {
    id: botId,
    package: PLUGIN,
    config: { trigger: 'always', cooldown: 0, userLimit: 0, dailyReplies: 0, ...config },
  })
  await waitFor(async () => (await app.call<any[]>('bots.plugins.list', { id: botId })).find((p) => p.package === PLUGIN)?.status === 'active')
}

/** Sends a message as a QQ user and waits until the bot has handled it. */
async function say(text: string, options: { user?: string; group?: string; direct?: boolean; wait?: boolean } = {}) {
  const before = (await app.call<any[]>('bots.messages', { id: botId, limit: 500 })).length
  const message = [{ type: 'text', data: { text } }]
  if (options.direct) napcat.pushPrivateMessage(options.user ?? '42', message)
  else napcat.pushGroupMessage(options.group ?? '500', options.user ?? '42', message)
  if (options.wait === false) return
  await waitFor(async () => (await app.call<any[]>('bots.messages', { id: botId, limit: 500 })).length > before)
  await sleep(200)
}

/** Runs `send` and returns how many LLM requests it caused. */
async function llmCalls(send: () => Promise<void>) {
  const before = llm.requests.length
  await send()
  await sleep(150)
  return llm.requests.length - before
}

beforeAll(async () => {
  llm = await createMockOpenAI()
  napcat = await createMockNapCat()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
  const bot = await app.call('bots.create', {
    name: 'Guarded',
    adapter: { type: 'onebot', config: { mode: 'forward', url: napcat.url } },
    plugins: [{ package: PLUGIN }],
  })
  botId = bot.id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
})

afterAll(async () => {
  await app?.stop()
  await napcat?.close()
  await llm?.close()
})

describe('llm-chat guardrails', () => {
  it('ships with limits on by default', async () => {
    const plugin = (await app.call<any[]>('bots.plugins.list', { id: botId })).find((p) => p.package === PLUGIN)
    const defaults = Object.fromEntries(Object.entries<any>(plugin.configSchema.properties).map(([key, value]) => [key, value.default]))
    expect(defaults).toMatchObject({ cooldown: 3, userLimit: 5, userWindow: 60, dailyReplies: 300, dailyTokens: 0, maxInputChars: 1000, privateChat: true })
  })

  it('limits replies per user and sends the notice only once', async () => {
    await configure({ userLimit: 2, limitNotice: 'slow down' })
    const calls = await llmCalls(async () => {
      for (const text of ['one', 'two', 'three', 'four']) await say(text)
    })
    expect(calls).toBe(2)
    expect(notices('slow down')).toBe(1)
    // Another user still gets answers.
    expect(await llmCalls(() => say('hello', { user: '43' }))).toBe(1)
  })

  it('replies only in allowed groups, not to ignored users, and not in private chats when turned off', async () => {
    await configure({ groups: ['600'], ignoreUsers: ['13'], privateChat: false })
    expect(await llmCalls(() => say('in another group', { group: '500' }))).toBe(0)
    expect(await llmCalls(() => say('from a bot', { group: '600', user: '13' }))).toBe(0)
    expect(await llmCalls(() => say('direct', { direct: true }))).toBe(0)
    expect(await llmCalls(() => say('allowed', { group: '600' }))).toBe(1)
  })

  it('waits for the chat cooldown', async () => {
    await configure({ cooldown: 0.8 })
    expect(await llmCalls(() => say('first'))).toBe(1)
    expect(await llmCalls(() => say('too soon', { user: '43' }))).toBe(0)
    await sleep(800)
    expect(await llmCalls(() => say('after the cooldown', { user: '43' }))).toBe(1)
  })

  it('answers one message at a time per chat', async () => {
    await configure({})
    llm.enqueue({ text: 'slow reply', delayMs: 500 })
    const calls = await llmCalls(async () => {
      await say('first', { wait: false })
      await sleep(100)
      await say('second while busy', { user: '43' })
      await sleep(500)
    })
    expect(calls).toBe(1)
  })

  it('stops at the daily reply limit, and the count survives a reload', async () => {
    await configure({ dailyReplies: 2 })
    const calls = await llmCalls(async () => {
      for (const text of ['a', 'b', 'c']) await say(text)
    })
    expect(calls).toBe(2)
    expect(JSON.parse(await readFile(usageFile(), 'utf8'))).toMatchObject({ replies: 2 })
    await configure({ dailyReplies: 2 }, true)
    expect(await llmCalls(() => say('after reload'))).toBe(0)
  })

  it('stops at the daily token budget', async () => {
    // The mock reports 15 tokens per reply.
    await configure({ dailyTokens: 20 })
    const calls = await llmCalls(async () => {
      for (const text of ['a', 'b', 'c']) await say(text)
    })
    expect(calls).toBe(2)
  })

  it('cuts long messages before they reach the model', async () => {
    await configure({ maxInputChars: 100 })
    await say('x'.repeat(500))
    const sent = llm.requests.at(-1).messages.at(-1).content as string
    expect(sent).toBe(`user42: ${'x'.repeat(100)}…`)
  })
})
