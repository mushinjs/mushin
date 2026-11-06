import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockNapCat } from './helpers/mock-napcat'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let napcat: Awaited<ReturnType<typeof createMockNapCat>>
let botId: string

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const groupTexts = (group: string) => napcat.sent
  .filter((call) => call.action === 'send_group_msg' && String(call.params.group_id) === group)
  .map((call) => call.params.message.find((segment: any) => segment.type === 'text')?.data.text)
const mention = () => ({ type: 'at', data: { qq: napcat.selfId } })
const text = (value: string) => ({ type: 'text', data: { text: value } })

beforeAll(async () => {
  llm = await createMockOpenAI()
  llm.setFallback({ text: 'LLM chat answered' })
  napcat = await createMockNapCat({ nickname: '小喵' })
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
  const bot = await app.call('bots.create', {
    name: 'Companion',
    adapter: { type: 'onebot', config: { mode: 'forward', url: napcat.url } },
    plugins: [
      { package: '@mushin/bot-plugin-llm-chat' },
      { package: '@mushin/bot-plugin-companion', config: { debounce: 'fast', typingSpeed: 50, excludeGroups: ['700'] } },
    ],
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

describe('companion chat', () => {
  it('answers a mention in a few messages, instead of the LLM chat flow', async () => {
    const before = llm.requests.length
    llm.enqueue({ text: '{"action":"reply","target":"#1","intent":"装傻","reason":"在叫我"}' }, { text: '啊？|叫我干嘛' })
    napcat.pushGroupMessage('500', '42', [mention(), text(' 在吗')])
    await waitFor(() => groupTexts('500').length >= 2, 12_000)
    expect(groupTexts('500')).toEqual(['啊？', '叫我干嘛'])
    const requests = llm.requests.slice(before)
    expect(requests).toHaveLength(2)
    expect(requests[0].messages[1].content).toContain('user42：@你 在吗')
    const out = (await app.call<any[]>('bots.messages', { id: botId, limit: 10 })).filter((record) => record.direction === 'out')
    expect(out.at(-1).source).toMatchObject({ kind: 'llm', plugin: '@mushin/bot-plugin-companion' })
  }, 20_000)

  it('lets small talk go by without asking a model', async () => {
    const before = llm.requests.length
    napcat.pushGroupMessage('500', '43', [text('今天好热')])
    await sleep(2500)
    expect(llm.requests.length).toBe(before)
  })

  it('leaves excluded groups to the LLM chat flow', async () => {
    napcat.pushGroupMessage('700', '42', [mention(), text(' 在吗')])
    await waitFor(() => groupTexts('700').length >= 1, 8000)
    expect(groupTexts('700')).toEqual(['LLM chat answered'])
  })
})
