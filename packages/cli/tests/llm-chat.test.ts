import { readFile } from 'node:fs/promises'
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
const notices = (text: string) => napcat.sent.filter((call) => call.params?.message?.[0]?.data?.text === text).length
const chatFlows = async () => (await app.call<any[]>('flows.list')).filter((flow) => flow.source?.plugin === PLUGIN)
const chatFlow = async () => app.call('flows.get', { id: (await chatFlows()).find((flow) => flow.bots.includes(botId)).id })

/** Sends old-style settings (limits off unless set), which the plugin turns into its flow. */
async function configure(config: Record<string, unknown>) {
  const before = JSON.stringify((await chatFlow()).nodes)
  const settings = { trigger: 'always', cooldown: 0, userLimit: 0, dailyReplies: 0, ...config }
  await app.call('bots.plugins.configure', { id: botId, package: PLUGIN, config: settings })
  await waitFor(async () => (await app.call<any[]>('bots.plugins.list', { id: botId })).find((p) => p.package === PLUGIN)?.status === 'active')
  // The flow is rewritten unless these settings make the same flow.
  await waitFor(async () => JSON.stringify((await chatFlow()).nodes) !== before || JSON.stringify(config) === '{}', 2000).catch(() => {})
}

/**
 * Moves the tests to a new bot with its own NapCat, so its flow starts with fresh daily counters
 * (counters stay with a node when its settings change).
 */
async function freshBot(config: Record<string, unknown>) {
  await app.call('bots.stop', { id: botId })
  napcat = await createMockNapCat()
  const bot = await app.call('bots.create', {
    name: `Budget ${Date.now()}`,
    adapter: { type: 'onebot', config: { mode: 'forward', url: napcat.url } },
    plugins: [{ package: PLUGIN, config: { trigger: 'always', cooldown: 0, userLimit: 0, ...config } }],
  })
  botId = bot.id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
  await waitFor(async () => (await chatFlows()).some((flow) => flow.bots.includes(botId)))
}

/** Sends a message as a QQ user and waits until the bot has handled it. */
async function say(text: string, options: { user?: string; group?: string; direct?: boolean } = {}) {
  const before = (await app.call<any[]>('bots.messages', { id: botId, limit: 500 })).length
  const message = [{ type: 'text', data: { text } }]
  if (options.direct) napcat.pushPrivateMessage(options.user ?? '42', message)
  else napcat.pushGroupMessage(options.group ?? '500', options.user ?? '42', message)
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
  await waitFor(async () => (await chatFlows()).length === 1)
})

afterAll(async () => {
  await app?.stop()
  await napcat?.close()
  await llm?.close()
})

describe('LLM chat as a flow', () => {
  it('makes a flow on the bot with the old default limits as nodes, and keeps no settings of its own', async () => {
    const flow = await chatFlow()
    expect(flow).toMatchObject({ bots: [botId], source: { kind: 'plugin', plugin: PLUGIN }, issues: [] })
    expect(flow.nodes.map((node: any) => node.type)).toEqual(['trigger.message', 'logic.cooldown', 'logic.rateLimit', 'logic.dailyQuota', 'ai.chat', 'action.reply'])
    expect(flow.nodes.find((node: any) => node.type === 'logic.rateLimit').config).toMatchObject({ limit: 5, seconds: 60 })
    const plugin = (await app.call<any[]>('bots.plugins.list', { id: botId })).find((p) => p.package === PLUGIN)
    expect(Object.keys(plugin.configSchema.properties ?? {})).toEqual([])
    // The flows runner came along, since the flow runs on the bot.
    expect((await app.call<any[]>('bots.plugins.list', { id: botId })).find((p) => p.package === '@mushin/bot-plugin-flows')?.status).toBe('active')
    await expect(app.call('flows.delete', { id: flow.id })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('answers @-mentions and private chats, not other group messages or commands', async () => {
    expect(await llmCalls(() => say('just chatting'))).toBe(0)
    expect(await llmCalls(() => say('hi there', { direct: true }))).toBe(1)
    const reply = (await app.call<any[]>('bots.messages', { id: botId, limit: 500 })).filter((record) => record.direction === 'out').at(-1)
    expect(reply.source).toMatchObject({ kind: 'flow', node: '回复', provider: 'Mock', model: 'mock-model' })
    await configure({})
    expect(await llmCalls(() => say('/help'))).toBe(0)
  })

  it('limits replies per user and sends the notice only once', async () => {
    await configure({ userLimit: 2, limitNotice: 'slow down' })
    const calls = await llmCalls(async () => {
      for (const text of ['one', 'two', 'three', 'four']) await say(text, { user: '50' })
    })
    expect(calls).toBe(2)
    expect(notices('slow down')).toBe(1)
    // Another user still gets answers.
    expect(await llmCalls(() => say('hello', { user: '51' }))).toBe(1)
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

  it('stops at the daily reply limit, and the count survives a restart', async () => {
    await freshBot({ dailyReplies: 2 })
    const calls = await llmCalls(async () => {
      for (const text of ['a', 'b', 'c']) await say(text)
    })
    expect(calls).toBe(2)
    await waitFor(async () => {
      const saved = JSON.parse(await readFile(join(app.baseDir, 'data', 'flows-usage.json'), 'utf8'))
      return Object.values<any>(saved).some((counter) => counter.count === 2)
    })
    await app.call('bots.start', { id: botId })
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
    expect(await llmCalls(() => say('after restart'))).toBe(0)
  })

  it('stops at the daily token budget', async () => {
    // The mock reports 15 tokens per reply.
    await freshBot({ dailyReplies: 0, dailyTokens: 20 })
    const calls = await llmCalls(async () => {
      for (const text of ['a', 'b', 'c']) await say(text)
    })
    expect(calls).toBe(2)
  })

  it('cuts long messages and sends the chat as context', async () => {
    await configure({ maxInputChars: 100, historySize: 2 })
    await say('earlier, unanswered', { user: '7' })
    await configure({ maxInputChars: 100, historySize: 2, trigger: 'mention' })
    napcat.pushGroupMessage('500', '42', [{ type: 'at', data: { qq: napcat.selfId } }, { type: 'text', data: { text: 'x'.repeat(500) } }])
    await waitFor(() => llm.requests.at(-1)?.messages.at(-1).content.startsWith('user42: x'))
    const messages = llm.requests.at(-1).messages
    expect(messages.at(-1).content).toBe(`user42: ${'x'.repeat(100)}…`)
    expect(messages.slice(1, -1).map((message: any) => message.content)).toContain('user7: earlier, unanswered')
  })

  it('goes on "error" when the model fails, without breaking the run', async () => {
    await configure({ maxTokens: 64 })
    const flow = await chatFlow()
    await app.call('providers.update', { id: (await app.call('providers.list')).providers[0].id, config: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-test-1234567890' } })
    const { trace } = await app.call('flows.test', { id: flow.id, text: 'hello', private: true })
    expect(trace.error).toBeUndefined()
    expect(trace.steps.find((step: any) => step.nodeId === 'ask')).toMatchObject({ exec: 'error', outputs: { error: expect.any(String) } })
    await app.call('providers.update', { id: (await app.call('providers.list')).providers[0].id, config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' } })
  })

  it('keeps edits made on the canvas when the bot restarts, and removes the flow when the plugin is turned off', async () => {
    const flow = await chatFlow()
    const nodes = flow.nodes.map((node: any) => (node.type === 'ai.chat' ? { ...node, config: { ...node.config, systemPrompt: 'Be brief.' } } : node))
    await app.call('flows.update', { id: flow.id, nodes })
    await app.call('bots.start', { id: botId })
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
    await sleep(200)
    expect((await chatFlow()).nodes.find((node: any) => node.type === 'ai.chat').config.systemPrompt).toBe('Be brief.')
    await app.call('bots.plugins.disable', { id: botId, package: PLUGIN })
    await waitFor(async () => !(await chatFlows()).some((flow) => flow.bots.includes(botId)))
  })
})
