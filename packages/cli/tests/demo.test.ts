import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance
let botId: string

const PACKAGE = '@mushin/plugin-demo'
const allOn = {
  provider: true,
  bot: true,
  flows: { menu: true, command: true, keyword: true, branch: true, cooldown: true, wait: true, llm: true, classify: true },
}

const outgoing = async () => (await app.call<any[]>('bots.messages', { id: botId, limit: 500 }))
  .filter((record) => record.direction === 'out' && record.source.kind !== 'manual')
  .map((record) => record.segments.filter((s: any) => s.type === 'text').map((s: any) => s.data.text).join(''))

/** Sends as the test user and returns the bot's next reply. */
async function say(text: string, options: Record<string, unknown> = {}) {
  const before = (await outgoing()).length
  await app.call('demo.say', { text, ...options })
  return waitFor(async () => (await outgoing())[before])
}

beforeAll(async () => {
  app = await startInstance()
})

afterAll(async () => {
  await app?.stop()
})

describe('demo plugin', () => {
  it('is installed but not enabled by default', async () => {
    const catalog = await app.call<any[]>('plugins.catalog', { kind: 'app' })
    expect(catalog.map((entry) => entry.package)).toContain(PACKAGE)
    expect(app.ctx.manager.entries.some((entry) => entry.package === PACKAGE)).toBe(false)
  })

  it('offers the provider type, adapter and node type without creating anything', async () => {
    await app.call('plugins.enable', { package: PACKAGE })
    expect((await app.call<any[]>('providers.types')).map((type) => type.id)).toContain('demo')
    expect((await app.call<any[]>('bots.adapters')).map((adapter) => adapter.id)).toContain('demo')
    expect((await app.call<any[]>('flows.nodeTypes')).map((type) => type.type)).toContain('demo.waitReply')
    expect((await app.call('providers.list')).providers).toEqual([])
    expect(await app.call('bots.list')).toEqual([])
    expect(await app.call('flows.list')).toEqual([])
  })

  it('creates the checked provider, bot and flows', async () => {
    await app.call('plugins.configure', { id: 'demo', config: allOn })
    const { providers } = await app.call('providers.list')
    expect(providers).toMatchObject([{ name: '演示模型', type: 'demo', models: ['demo-chat'] }])
    const bots = await app.call<any[]>('bots.list')
    expect(bots).toMatchObject([{ name: '演示机器人', adapter: { type: 'demo' }, provider: providers[0].id }])
    botId = bots[0].id
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
    const flows = await app.call<any[]>('flows.list')
    expect(flows).toHaveLength(8)
    for (const flow of flows) expect(flow).toMatchObject({ bots: [botId], errors: 0, warnings: 0 })
  })

  it('greets with /help so the chat shows up', async () => {
    const reply = await waitFor(async () => (await outgoing())[0])
    expect(reply).toContain('/quiz')
  })

  it('answers commands, keywords and branches', async () => {
    expect(await say('/ping')).toBe('pong！Demo user 🏓')
    expect(await say('/echo 你好 Mushin')).toBe('你好 Mushin')
    expect(await say('大家早上好')).toBe('Demo user，早上好！☀️ 今天也要元气满满。')
    expect(await say('/score 85')).toBe('85 分，及格了 🎉')
    expect(await say('/score 30')).toBe('30 分，还没及格，继续加油 💪')
  })

  it('counts per user and cools down', async () => {
    expect(await say('/checkin')).toBe('签到成功！Demo user 现在有 10 积分。')
    expect(await say('/checkin')).toBe('你刚签到过，一分钟后再来吧。')
    expect(await say('/checkin', { userId: '10002', userName: 'Bob' })).toBe('签到成功！Bob 现在有 10 积分。')
  })

  it('waits for the next message from the same person', async () => {
    expect(await say('/quiz')).toContain('一年有几个季节')
    expect(await say('4')).toBe('答对了！🎯')
    await say('/quiz')
    expect(await say('3')).toBe('「3」不对哦，答案是 4。')
  })

  it('answers through the offline demo provider, and classifies intents', async () => {
    expect(await say('/ai 讲个笑话')).toBe('【演示模型】你说的是「讲个笑话」。这是离线演示提供商生成的回复，换成真实模型后这里就是 AI 的回答。')
    expect(await say('/客服 我要退款')).toBe('退款请发一下订单号，我们会在 24 小时内处理。')
    expect(await say('/客服 什么时候发货')).toBe('订单一般 48 小时内发货，可以在订单页查看物流。')
    expect(await say('/客服 hello')).toContain('[Demo model]')
  })

  it('replays messages sent from the dashboard as the test user', async () => {
    const before = (await outgoing()).length
    await app.call('bots.send', { id: botId, channel: { type: 'group', id: 'demo' }, text: '/ping' })
    expect(await waitFor(async () => (await outgoing())[before])).toBe('pong！Demo user 🏓')
  })

  it('deletes what gets unchecked, and everything when disabled', async () => {
    await app.call('plugins.configure', { id: 'demo', config: { ...allOn, flows: { ...allOn.flows, llm: false } } })
    const names = (await app.call<any[]>('flows.list')).map((flow) => flow.name)
    expect(names).toHaveLength(7)
    expect(names).not.toContain('演示：大模型回复')

    await app.call('plugins.disable', { id: 'demo' })
    await waitFor(async () => (await app.call<any[]>('flows.list')).length === 0)
    expect(await app.call('bots.list')).toEqual([])
    expect((await app.call('providers.list')).providers).toEqual([])
  })
})
