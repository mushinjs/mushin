import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockNapCat } from './helpers/mock-napcat'
import { createMockOpenAI } from './helpers/mock-openai'

const LLM_CHAT = '@mushin/bot-plugin-llm-chat'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let napcat: Awaited<ReturnType<typeof createMockNapCat>>
let botId: string
let helper: any
let cat: any

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const outgoing = async () => (await app.call<any[]>('bots.messages', { id: botId, limit: 500 })).filter((record) => record.direction === 'out')
const textOf = (record: any) => record.segments.filter((s: any) => s.type === 'text').map((s: any) => s.data.text).join('')

/** Sends a group message as a QQ user and returns the bot's reply record. */
async function say(text: string, group = '500', user = '42') {
  const before = (await outgoing()).length
  napcat.pushGroupMessage(group, user, [{ type: 'text', data: { text } }])
  return waitFor(async () => (await outgoing())[before])
}

const lastSystem = () => llm.requests.at(-1).messages[0].content as string

beforeAll(async () => {
  llm = await createMockOpenAI()
  napcat = await createMockNapCat()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
  const bot = await app.call('bots.create', {
    name: 'Mimi',
    adapter: { type: 'onebot', config: { mode: 'forward', url: napcat.url } },
    plugins: [{ package: LLM_CHAT, config: { trigger: 'always', cooldown: 0, userLimit: 0, dailyReplies: 0 } }],
  })
  botId = bot.id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
})

afterAll(async () => {
  await app?.stop()
  await napcat?.close()
  await llm?.close()
})

describe('personas', () => {
  it('keeps personas and imports character cards', async () => {
    helper = await app.call('personas.create', { name: '客服小助手', prompt: '你是{bot.name}的客服，称呼用户为{user.name}。', avoid: '不要承诺退款' })
    cat = await app.call('personas.create', {
      name: '毒舌猫娘',
      prompt: '你是一只毒舌猫娘。',
      examples: [{ user: '你好', assistant: '哼，才不想理你喵' }],
      temperature: 1.2,
    })
    const { created } = await app.call('personas.import', {
      data: {
        spec: 'chara_card_v2',
        data: { name: '毒舌猫娘', description: '{{char}} is grumpy.', mes_example: '<START>\n{{user}}: hi\n{{char}}: Hmph, {{user}}.', tags: ['cat'] },
      },
    })
    expect(created[0]).toMatchObject({
      name: '毒舌猫娘 (2)',
      prompt: expect.stringContaining('毒舌猫娘: 毒舌猫娘 is grumpy.'),
      examples: [{ user: 'hi', assistant: 'Hmph, {user.name}.' }],
      tags: ['cat'],
    })
    const exported = await app.call('personas.export', { ids: [created[0].id] })
    expect(exported).toMatchObject({ format: 'mushin-personas', personas: [{ name: '毒舌猫娘 (2)' }] })
    await app.call('personas.delete', { id: created[0].id })
    expect((await app.call<any[]>('personas.list')).map((persona) => persona.name)).toEqual(['客服小助手', '毒舌猫娘'])
  })

  it('picks a persona per chat by rule, then by default', async () => {
    await app.call('personas.updateBotSettings', {
      bot: botId,
      default: helper.id,
      rules: [{ when: 'group', ids: ['600'], persona: cat.id }, { when: 'time', from: '23:00', to: '06:00', persona: cat.id }],
    })
    expect(await app.call('personas.resolve', { bot: botId, group: '600' })).toMatchObject({ persona: { name: '毒舌猫娘' }, reason: 'rule' })
    expect(await app.call('personas.resolve', { bot: botId, group: '500', time: '02:30' })).toMatchObject({ persona: { name: '毒舌猫娘' }, reason: 'rule', rule: { when: 'time' } })
    const plain = await app.call('personas.resolve', { bot: botId, group: '500', userName: '小明', time: '12:00' })
    expect(plain).toMatchObject({ persona: { name: '客服小助手' }, reason: 'default' })
    expect(plain.prepared.prompt).toBe('你是Mimi的客服，称呼用户为小明。\n\nNever do any of these:\n不要承诺退款')
    await expect(app.call('personas.updateBotSettings', { bot: botId, rules: [{ when: 'time', from: '08:00', persona: cat.id }] })).rejects.toMatchObject({ code: 'invalid_input' })
    // Keep the rest of the tests independent of the clock.
    await app.call('personas.updateBotSettings', { bot: botId, rules: [{ when: 'group', ids: ['600'], persona: cat.id }] })
  })

  it('makes LLM chat speak as the persona and shows it in provenance', async () => {
    const reply = await say('有人吗', '600')
    expect(lastSystem()).toBe('你是一只毒舌猫娘。')
    expect(llm.requests.at(-1).messages.slice(1, 3)).toEqual([{ role: 'user', content: '你好' }, { role: 'assistant', content: '哼，才不想理你喵' }])
    expect(llm.requests.at(-1).temperature).toBe(1.2)
    expect(reply.source).toMatchObject({ kind: 'flow', persona: '毒舌猫娘' })
  })

  it('switches a chat with /persona, for admins only', async () => {
    llm.requests.length = 0
    expect(textOf(await say('/persona', '500'))).toContain('当前人格：客服小助手')
    expect(textOf(await say('/persona 毒舌猫娘', '500'))).toBe('需要管理员及以上才能切换人格')
    await app.call('permissions.update', { bot: botId, admins: ['42'] })
    expect(textOf(await say('/persona 毒舌猫娘', '500'))).toBe('已切换为：毒舌猫娘')
    expect((await app.call('personas.botSettings', { bot: botId })).chats).toEqual([{ chat: 'group:500', persona: { id: cat.id, name: '毒舌猫娘' } }])
    expect(llm.requests).toHaveLength(0)
    await say('hello', '500')
    expect(lastSystem()).toMatch(/^你是一只毒舌猫娘/)
    expect(textOf(await say('/persona reset', '500'))).toBe('已恢复默认人格：客服小助手')
  })

  it('switches persona for one branch of a flow, and can rewrite fixed replies', async () => {
    const flow = await app.call('flows.create', {
      name: 'Persona branch',
      bots: [botId],
      enabled: false,
      nodes: [
        { id: 'kw', type: 'trigger.keyword', config: { keywords: ['meow'] } },
        { id: 'use', type: 'persona.use', config: { persona: cat.id, rewrite: true } },
        { id: 'ask', type: 'ai.chat' },
        { id: 'fixed', type: 'action.reply', config: { text: '今天天气不错' } },
      ],
      edges: [
        { source: 'kw', sourceHandle: 'exec:next', target: 'use', targetHandle: 'exec' },
        { source: 'use', sourceHandle: 'exec:next', target: 'ask', targetHandle: 'exec' },
        { source: 'ask', sourceHandle: 'exec:next', target: 'fixed', targetHandle: 'exec' },
      ],
    })
    llm.requests.length = 0
    const { trace } = await app.call('flows.test', { id: flow.id, text: 'meow' })
    expect(trace.steps.find((step: any) => step.nodeId === 'use').outputs).toEqual({ name: '毒舌猫娘' })
    expect(llm.requests[0].messages[0].content).toMatch(/^你是一只毒舌猫娘。$/)
    expect(llm.requests[1].messages.at(-1)).toEqual({ role: 'user', content: '今天天气不错' })
    expect(llm.requests[1].messages[0].content).toContain('Rewrite the message')
    expect(trace.replies).toEqual(['Hi from LLM'])

    // Without a persona node, ai.chat follows the bot's rules; "none" turns personas off.
    const nodes = [
      { id: 'kw', type: 'trigger.keyword', config: { keywords: ['meow'] } },
      { id: 'ask', type: 'ai.chat' },
    ]
    await app.call('flows.update', { id: flow.id, nodes, edges: [{ source: 'kw', sourceHandle: 'exec:next', target: 'ask', targetHandle: 'exec' }] })
    await app.call('flows.test', { id: flow.id, text: 'meow', userName: '小红' })
    expect(lastSystem()).toBe('你是Mimi的客服，称呼用户为小红。\n\nNever do any of these:\n不要承诺退款')
    await app.call('flows.update', {
      id: flow.id,
      nodes: [nodes[0], { id: 'off', type: 'persona.use', config: { persona: 'none' } }, nodes[1]],
      edges: [
        { source: 'kw', sourceHandle: 'exec:next', target: 'off', targetHandle: 'exec' },
        { source: 'off', sourceHandle: 'exec:next', target: 'ask', targetHandle: 'exec' },
      ],
    })
    await app.call('flows.test', { id: flow.id, text: 'meow' })
    expect(lastSystem()).toMatch(/^You are a friendly chat bot/)
  })

  it('drops a deleted persona from the bots that used it', async () => {
    await app.call('personas.delete', { id: cat.id })
    const settings = await app.call('personas.botSettings', { bot: botId })
    expect(settings).toMatchObject({ default: helper.id, rules: [], chats: [] })
    await sleep(50)
  })
})
