import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockNapCat } from './helpers/mock-napcat'
import { createMockOpenAI } from './helpers/mock-openai'

const LLM_CHAT = '@mushin/bot-plugin-llm-chat'
const RULES = '# 群规\n\n## 广告\n\n群里禁止发广告和推广链接，违者踢出。\n\n## 发言\n\n请友善发言，不要刷屏。\n\n## 维护\n\n服务器每周四早上 8 点维护。'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let napcat: Awaited<ReturnType<typeof createMockNapCat>>
let provider: string
let botId: string
let base: any

const outgoing = async () => (await app.call<any[]>('bots.messages', { id: botId, limit: 500 })).filter((record) => record.direction === 'out')
const textOf = (record: any) => record.segments.filter((s: any) => s.type === 'text').map((s: any) => s.data.text).join('')

async function say(text: string, user = '42', group = '500', segments?: any[]) {
  const before = (await outgoing()).length
  napcat.pushGroupMessage(group, user, segments ?? [{ type: 'text', data: { text } }])
  return waitFor(async () => (await outgoing())[before])
}

beforeAll(async () => {
  llm = await createMockOpenAI()
  napcat = await createMockNapCat()
  app = await startInstance()
  provider = (await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })).id
  const bot = await app.call('bots.create', {
    name: 'Mimi',
    adapter: { type: 'onebot', config: { mode: 'forward', url: napcat.url } },
    plugins: [{ package: LLM_CHAT, config: { trigger: 'always', cooldown: 0, userLimit: 0, dailyReplies: 0 } }],
  })
  botId = bot.id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
  await app.call('permissions.update', { bot: botId, masters: ['1'] })
})

afterAll(async () => {
  await app?.stop()
  await napcat?.close()
  await llm?.close()
})

describe('knowledge bases', () => {
  it('splits, embeds and searches a document', async () => {
    expect(await app.call('providers.embedChoices')).toEqual([{ value: provider, label: 'Mock' }])
    base = await app.call('kb.create', { name: '群规', provider, model: 'mock-embed' })
    expect(base).toMatchObject({ dimension: 64, chunkSize: 500, topK: 5 })
    const doc = await app.call('kb.docs.add', { base: base.id, text: RULES, name: '群规' })
    await waitFor(async () => (await app.call<any[]>('kb.docs.list', { base: base.id }))[0].status === 'ready')
    const { chunks } = await app.call('kb.chunks.list', { base: base.id, doc: doc.id })
    expect(chunks.map((chunk: any) => chunk.title)).toEqual(['群规 > 广告', '群规 > 发言', '群规 > 维护'])
    expect(chunks.every((chunk: any) => chunk.embedded && !('vector' in chunk))).toBe(true)
    // The same content is refused.
    await expect(app.call('kb.docs.add', { base: base.id, text: RULES })).rejects.toMatchObject({ code: 'conflict' })

    const result = await app.call('kb.search', { query: '能发广告吗', bases: ['群规'] })
    expect(result.semantic).toBe(true)
    expect(result.hits[0]).toMatchObject({ title: '群规 > 广告', baseName: '群规', docTitle: '群规', ranks: { keyword: 1 } })
    expect(result.hits[0].similarity).toBeGreaterThan(0)
    const [summary] = await app.call<any[]>('kb.list')
    expect(summary).toMatchObject({ docs: 1, chunks: 3, embedded: 3 })
  })

  it('falls back to keywords when the embedding model fails', async () => {
    await llm.close()
    const result = await app.call('kb.search', { query: '维护时间', bases: [base.id] })
    expect(result.semantic).toBe(false)
    expect(result.warnings[0]).toContain('searched by keywords only')
    expect(result.hits[0].title).toBe('群规 > 维护')
    llm = await createMockOpenAI()
    await app.call('providers.update', { id: provider, config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' } })
  })

  it('answers from the base in the bot\'s LLM chat flow and records the source', async () => {
    const [flow] = await app.call<any[]>('kb.flowChoices', { base: base.id })
    expect(flow).toMatchObject({ llmChat: true, uses: false, bots: [botId] })
    expect(await app.call('kb.useInFlow', { flow: flow.id, bases: [base.id] })).toMatchObject({ added: true, node: 'kb' })
    const updated = await app.call('flows.get', { id: flow.id })
    expect(updated.issues.filter((issue: any) => issue.severity === 'error')).toEqual([])
    expect(updated.nodes.find((node: any) => node.type === 'ai.chat').inputs).toMatchObject({ knowledge: '{{kb.context}}' })
    expect((await app.call<any[]>('kb.flowChoices', { base: base.id }))[0].uses).toBe(true)

    llm.enqueue({ text: '不能发广告哦' })
    const reply = await say('能发广告吗')
    expect(textOf(reply)).toBe('不能发广告哦')
    const sent = llm.requests.at(-1).messages.at(-1).content as string
    expect(sent).toContain('<reference>\n[1] 群规 > 广告\n群里禁止发广告')
    expect(sent).toContain('<message>\n')
    expect(reply.source.knowledge[0]).toMatchObject({ base: base.id, title: '群规 > 广告' })

    // Off topic: nothing scores high enough, so the model gets the message alone.
    llm.enqueue({ text: '你好呀' })
    await say('zzz qqq')
    expect(llm.requests.at(-1).messages.at(-1).content).not.toContain('<reference>')
  })

  it('lets admins remember, collect and forget from chat', async () => {
    await app.call('kb.update', { id: base.id, bots: [botId] })
    const names = async () => (await app.call('commands.list', { bot: botId })).commands.map((command: any) => command.name) as string[]
    await waitFor(async () => (await names()).includes('记住'))
    expect(await names()).toEqual(expect.arrayContaining(['记住', '收录', '忘记']))

    expect(textOf(await say('/记住 群主是小明', '42'))).toContain('需要管理员')
    expect(textOf(await say('/记住 群主是小明', '1'))).toBe('已记进知识库「群规」')

    // LLM chat answers every message here; wait for that answer before quoting the message.
    const before = (await outgoing()).length
    const quoted = napcat.pushGroupMessage('500', '7', [{ type: 'text', data: { text: '周末活动在晚上 9 点开始' } }])
    await waitFor(async () => (await outgoing()).length > before)
    const collected = await say('', '1', '500', [{ type: 'reply', data: { id: String(quoted) } }, { type: 'text', data: { text: '/收录' } }])
    expect(textOf(collected)).toBe('已收录到知识库「群规」')

    const docs = await app.call<any[]>('kb.docs.list', { base: base.id })
    const notes = docs.find((doc) => doc.kind === 'notes')
    expect(notes).toMatchObject({ title: '随手记', chunks: 2 })
    expect((await app.call('kb.search', { query: '周末活动几点', bases: [base.id] })).hits[0].text).toBe('周末活动在晚上 9 点开始')

    expect(textOf(await say('/忘记 小明', '1'))).toBe('已从知识库「群规」删除 1 条')
    expect((await app.call('kb.chunks.list', { base: base.id, doc: notes.id })).total).toBe(1)
  })

  it('learns candidates from chat for review', async () => {
    await app.call('kb.update', { id: base.id, learn: { enabled: true, every: 50 } })
    llm.setFallback({ text: '好的' })
    for (const line of ['服务器周四几点维护？', '早上8点', '维护多久', '一般两个小时', '好的谢谢']) {
      await say(line, '42', '600')
    }
    llm.enqueue({ text: '```json\n[{"question":"服务器维护多久？","answer":"一般两个小时"},{"question":"禁止发广告和推广链接","answer":"违者踢出"}]\n```' })
    const result = await app.call('kb.learn', { base: base.id, bot: botId, chat: 'group:600' })
    // The second one is in the base already.
    expect(result.candidates.map((item: any) => item.question)).toEqual(['服务器维护多久？'])
    const prompt = llm.requests.at(-1).messages
    expect(prompt[0].content).toContain('knowledge worth keeping')
    expect(prompt[1].content).toContain('user42: 服务器周四几点维护？')
    expect(prompt[1].content).toContain('Mimi: 好的')

    // Nothing new to read since then.
    expect(await app.call('kb.learn', { base: base.id, bot: botId, chat: 'group:600' })).toMatchObject({ skipped: 'not enough new messages' })

    const [pending] = await app.call<any[]>('kb.candidates.list', { base: base.id, status: 'pending' })
    const accepted = await app.call('kb.candidates.accept', { id: pending.id, answer: '一般两个小时左右' })
    expect(accepted).toMatchObject({ status: 'accepted', chunk: expect.any(String) })
    const learned = (await app.call<any[]>('kb.docs.list', { base: base.id })).find((doc) => doc.kind === 'learned')
    expect(learned).toMatchObject({ title: '从对话学习', chunks: 1 })
    const { chunks } = await app.call('kb.chunks.list', { base: base.id, doc: learned.id })
    expect(chunks[0]).toMatchObject({ title: '服务器维护多久？', text: '问：服务器维护多久？\n答：一般两个小时左右' })
  })

  it('edits chunks, draws the map and switches to keywords only', async () => {
    const docs = await app.call<any[]>('kb.docs.list', { base: base.id })
    const rules = docs.find((doc) => doc.kind === 'text')
    const { chunks } = await app.call('kb.chunks.list', { base: base.id, doc: rules.id })
    const edited = await app.call('kb.chunks.update', { id: chunks[1].id, text: '请友善发言，不要刷屏，不要发色图。' })
    expect(edited).toMatchObject({ edited: true, embedded: true })
    const merged = await app.call('kb.chunks.merge', { id: chunks[0].id })
    expect(merged.text).toContain('不要发色图')
    expect((await app.call<any[]>('kb.docs.list', { base: base.id })).find((doc) => doc.id === rules.id).chunks).toBe(2)

    const graph = await app.call('kb.graph', { base: base.id, minSimilarity: 0 })
    expect(graph).toMatchObject({ byVector: true, total: 4 })
    expect(graph.nodes[0]).toMatchObject({ docTitle: expect.any(String) })
    expect(graph.edges.length).toBeGreaterThan(0)

    await app.call('kb.update', { id: base.id, provider: '' })
    const after = await app.call('kb.search', { query: '能发广告吗', bases: [base.id] })
    expect(after).toMatchObject({ semantic: false, warnings: [] })
    expect(after.hits[0].similarity).toBeUndefined()
    expect((await app.call<any[]>('kb.list'))[0]).toMatchObject({ provider: '', dimension: 0, embedded: 0 })

    await app.call('kb.docs.remove', { id: rules.id })
    await app.call('kb.delete', { id: base.id })
    expect(await app.call('kb.list')).toEqual([])
  })
})
