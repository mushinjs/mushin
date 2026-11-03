import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance
let botId: string
let flowId: string

const incoming = async (text: string) => (await app.call<any[]>('bots.messages', { id: botId, limit: 500 }))
  .filter((record) => record.direction === 'in' && record.segments.some((s: any) => s.type === 'text' && s.data.text === text))

beforeAll(async () => {
  app = await startInstance()
  await app.call('plugins.enable', { package: '@mushin/plugin-demo' })
  await app.call('plugins.configure', { id: 'demo', config: { bot: true } })
  botId = (await app.call<any[]>('bots.list'))[0].id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
  const flow = await app.call('flows.create', {
    name: 'Samples',
    bots: [botId],
    nodes: [
      { id: 'kw', type: 'trigger.keyword', config: { keywords: ['天气'] } },
      { id: 'ask', type: 'ai.chat', config: { prompt: [{ kind: 'system', text: '你是 {{sys.user}} 的助手' }, { kind: 'history', rounds: 5, source: 'chat' }, { kind: 'message', text: '' }] } },
      { id: 'say', type: 'action.reply', config: { text: 'ok' } },
    ],
    edges: [
      { source: 'kw', sourceHandle: 'exec:next', target: 'ask', targetHandle: 'exec' },
      { source: 'ask', sourceHandle: 'exec:next', target: 'say', targetHandle: 'exec' },
    ],
  })
  flowId = flow.id
})

afterAll(async () => {
  await app?.stop()
})

describe('flows and real messages', () => {
  it('links the runs a message started to it', async () => {
    await app.call('demo.say', { text: '早上好', userId: '20001', userName: 'Ann' })
    await app.call('demo.say', { text: '今天天气怎样', userId: '20001', userName: 'Ann' })
    const [record] = await waitFor(async () => {
      const found = await incoming('今天天气怎样')
      return found.length ? found : undefined
    })
    const { runs } = await waitFor(async () => {
      const result = await app.call('flows.history', { bot: botId, message: record.id })
      return result.runs.length && result.runs[0].status !== 'running' ? result : undefined
    })
    expect(runs).toEqual([expect.objectContaining({ flowId, message: record.id })])
    const [other] = await incoming('早上好')
    expect((await app.call('flows.history', { bot: botId, message: other.id })).runs).toEqual([])
  })

  it('tests a flow with a real message, its sender and its chat', async () => {
    const [record] = await incoming('今天天气怎样')
    const result = await app.call('flows.test', { id: flowId, sample: { bot: botId, id: record.id } })
    expect(result.matched).toBe(true)
    expect(result.trace.steps[0]).toMatchObject({ nodeId: 'kw', outputs: { userId: '20001', text: '今天天气怎样' } })
  })

  it('previews the prompt an LLM node sends, block by block, with the chat up to the message', async () => {
    const [record] = await incoming('今天天气怎样')
    const preview = await app.call('flows.preview', { id: flowId, nodeId: 'ask', sample: { bot: botId, id: record.id } })
    expect(preview.reached).toBe(true)
    expect(preview.messages).toEqual([
      expect.objectContaining({ role: 'system', content: '你是 Ann 的助手', from: 0, kind: 'system' }),
      expect.objectContaining({ role: 'user', content: 'Ann: 早上好', from: 1, kind: 'history' }),
      expect.objectContaining({ role: 'user', content: 'Ann: 今天天气怎样', from: 2, kind: 'message' }),
    ])
    // Unsaved edits of the node are previewed as they are.
    const edited = await app.call('flows.preview', { id: flowId, nodeId: 'ask', text: '天气', config: { prompt: [{ kind: 'message', text: '只说：{{sys.text}}' }] } })
    expect(edited.messages.map((line: any) => line.kind)).toEqual(['default', 'message'])
    expect(edited.messages[1].content).toBe('只说：天气')
  })
  it('tells which triggers a real message starts, with unsaved nodes', async () => {
    const [record] = await incoming('今天天气怎样')
    const saved = await app.call('flows.get', { id: flowId })
    const result = await app.call('flows.sampleMatch', { id: flowId, sample: { bot: botId, id: record.id } })
    expect(result.sys).toMatchObject({ userId: '20001', text: '今天天气怎样' })
    expect(result.triggers).toEqual([expect.objectContaining({ nodeId: 'kw', matched: true, outputs: expect.objectContaining({ keyword: '天气' }) })])
    const nodes = saved.nodes.map((node: any) => (node.id === 'kw' ? { ...node, config: { ...node.config, keywords: ['下雨'] } } : node))
    expect((await app.call('flows.sampleMatch', { id: flowId, sample: { bot: botId, id: record.id }, nodes })).triggers[0].matched).toBe(false)
  })
})
