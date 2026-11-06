import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DIGEST_EVERY } from '@mushin/bot-plugin-companion'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockNapCat } from './helpers/mock-napcat'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let napcat: Awaited<ReturnType<typeof createMockNapCat>>
let botId: string

const groupTexts = (group: string) => napcat.sent
  .filter((call) => call.action === 'send_group_msg' && String(call.params.group_id) === group)
  .map((call) => call.params.message.find((segment: any) => segment.type === 'text')?.data.text)
const text = (value: string) => ({ type: 'text', data: { text: value } })
const isDigest = (request: any) => request.messages[0].content.includes('整理自己在一个聊天里的记忆')

beforeAll(async () => {
  llm = await createMockOpenAI()
  llm.setFallback({ text: '{}' })
  napcat = await createMockNapCat({ nickname: '小喵' })
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
  const bot = await app.call('bots.create', {
    name: 'Companion',
    adapter: { type: 'onebot', config: { mode: 'forward', url: napcat.url } },
    plugins: [{ package: '@mushin/bot-plugin-companion', config: { debounce: 'fast', typingSpeed: 50, talkValue: 0, memory: true } }],
  })
  botId = bot.id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
  await waitFor(async () => (await app.call<any[]>('bots.plugins.list', { id: botId })).find((plugin) => plugin.package === '@mushin/bot-plugin-companion')?.status === 'active')
})

afterAll(async () => {
  await app?.stop()
  await napcat?.close()
  await llm?.close()
})

describe('companion memory', () => {
  it('digests a stretch of chat into memories and impressions', async () => {
    llm.enqueue({
      text: JSON.stringify({
        summary: 'user42 的猫生病了，大家在安慰他',
        memories: [{ text: 'user42 家的猫生病了', people: ['42'], topic: '宠物' }],
        people: [{ id: '42', impression: '很爱自己的猫', facts: ['养了只猫'], affinity: 0.1 }],
      }),
    })
    napcat.pushGroupMessage('500', '42', [text('我家猫生病了')])
    for (let index = 1; index < DIGEST_EVERY; index++) napcat.pushGroupMessage('500', String(43 + (index % 3)), [text(`抱抱 ${index}`)])
    await waitFor(async () => (await app.call<any[]>('companion.people', { bot: botId })).length === 1, 12_000)
    const digest = llm.requests.find(isDigest)
    expect(digest.messages[1].content).toContain('user42[42]：我家猫生病了')
    expect(await app.call('companion.people', { bot: botId })).toMatchObject([{ user: '42', name: 'user42', impression: '很爱自己的猫', facts: ['养了只猫'] }])
    const memories = await app.call<any[]>('companion.memories', { bot: botId })
    expect(memories).toMatchObject([{ chat: 'group:500', text: 'user42 家的猫生病了', people: ['42'] }])
    expect(memories[0].vector).toBeUndefined()
  }, 20_000)

  it('brings what it remembers into the conversation', async () => {
    const before = llm.requests.length
    llm.enqueue({ text: '{"action":"reply","reason":"在叫我"}' }, { text: '猫好点了吗' })
    napcat.pushGroupMessage('500', '42', [{ type: 'at', data: { qq: napcat.selfId } }, text(' 我家猫今天还是不吃饭')])
    await waitFor(() => groupTexts('500').includes('猫好点了吗'), 12_000)
    const [planner, reply] = llm.requests.slice(before)
    for (const request of [planner, reply]) {
      expect(request.messages[1].content).toContain('之前聊过的：user42 的猫生病了')
      expect(request.messages[1].content).toContain('- user42[42]：很爱自己的猫；养了只猫')
      expect(request.messages[1].content).toContain('- user42 家的猫生病了')
    }
  }, 20_000)

  it('forgets someone who asks', async () => {
    napcat.pushGroupMessage('500', '42', [text('/忘掉我')])
    await waitFor(() => groupTexts('500').some((value) => value?.startsWith('好，关于你的事我都忘了')), 8000)
    expect(await app.call('companion.people', { bot: botId })).toEqual([])
    expect(await app.call('companion.memories', { bot: botId })).toEqual([])
  })
})
