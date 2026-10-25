import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultConfig, start } from '../src/start'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockNapCat } from './helpers/mock-napcat'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let napcat: Awaited<ReturnType<typeof createMockNapCat>>
let botId: string
let flowId: string

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const groupReplies = () => napcat.sent.filter((call) => call.action === 'send_group_msg').map((call) => call.params.message[0].data.text)

async function say(text: string) {
  const before = (await app.call<any[]>('bots.messages', { id: botId, limit: 500 })).length
  napcat.pushGroupMessage('500', '42', [{ type: 'text', data: { text } }])
  await waitFor(async () => (await app.call<any[]>('bots.messages', { id: botId, limit: 500 })).length > before)
  await sleep(250)
}

const pingPong = {
  name: 'Ping pong',
  nodes: [
    { id: 'trigger', type: 'trigger.keyword', label: 'ping', config: { keywords: ['ping'], mode: 'exact' } },
    { id: 'answer', type: 'action.reply', label: 'Say pong', config: { text: 'pong, {user}' } },
  ],
  edges: [{ source: 'trigger', sourceHandle: 'exec:next', target: 'answer', targetHandle: 'exec' }],
}

beforeAll(async () => {
  llm = await createMockOpenAI()
  llm.setFallback({ text: 'LLM chat answered' })
  napcat = await createMockNapCat()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
  const bot = await app.call('bots.create', {
    name: 'Flowy',
    adapter: { type: 'onebot', config: { mode: 'forward', url: napcat.url } },
    plugins: [{ package: '@mushin/bot-plugin-llm-chat', config: { trigger: 'always', cooldown: 0, userLimit: 0 } }],
  })
  botId = bot.id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
})

afterAll(async () => {
  await app?.stop()
  await napcat?.close()
  await llm?.close()
})

describe('flows', () => {
  it('lists the built-in node types with their ports', async () => {
    const types = await app.call<any[]>('flows.nodeTypes')
    const byType = Object.fromEntries(types.map((type) => [type.type, type]))
    expect(Object.keys(byType)).toEqual(expect.arrayContaining(['trigger.keyword', 'logic.if', 'ai.chat', 'ai.classify', 'action.reply']))
    expect(byType['logic.if']).toMatchObject({ kind: 'action', execIn: true, execOut: ['true', 'false'] })
    expect(byType['ai.classify'].execOutFrom).toEqual({ key: 'labels', extra: ['other'] })
    expect(byType['trigger.keyword'].configSchema.properties.mode.enum).toEqual(['contains', 'startsWith', 'exact'])
  })

  it('creates a flow, lays it out and turns the flows plugin on for its bots', async () => {
    const flow = await app.call('flows.create', { ...pingPong, bots: [botId] })
    flowId = flow.id
    expect(flow.issues).toEqual([])
    expect(flow.nodes.every((node: any) => Number.isFinite(node.position.x) && Number.isFinite(node.position.y))).toBe(true)
    const plugins = await app.call<any[]>('bots.plugins.list', { id: botId })
    expect(plugins.find((plugin) => plugin.package === '@mushin/bot-plugin-flows')).toMatchObject({ enabled: true, status: 'active' })
  })

  it('answers through the flow before LLM chat, with flow provenance', async () => {
    const dashboard = await app.connect()
    const calls = llm.requests.length
    await say('ping')
    expect(groupReplies().at(-1)).toBe('pong, user42')
    expect(llm.requests.length).toBe(calls)
    const reply = (await app.call<any[]>('bots.messages', { id: botId })).at(-1)
    expect(reply.source).toEqual({ kind: 'flow', flow: 'Ping pong', node: 'Say pong' })

    const runs = await app.call<any[]>('flows.runs', { id: flowId })
    expect(runs.at(-1)).toMatchObject({ botId, test: false, text: 'ping', replies: ['pong, user42'] })
    expect(runs.at(-1).steps.map((step: any) => step.nodeId)).toEqual(['trigger', 'answer'])
    await waitFor(() => dashboard.events.some((event) => event.name === 'flows/run' && event.data.flowId === flowId))
    dashboard.close()
  })

  it('leaves unmatched messages to the other plugins', async () => {
    await say('hello there')
    expect(groupReplies().at(-1)).toBe('LLM chat answered')
  })

  it('tests a flow without sending anything', async () => {
    const sent = napcat.sent.length
    const result = await app.call('flows.test', { id: flowId, text: 'ping', userName: 'Ann' })
    expect(result.matched).toBe(true)
    expect(result.trace.replies).toEqual(['pong, Ann'])
    expect(result.trace.test).toBe(true)
    expect(napcat.sent.length).toBe(sent)
  })

  it('reports issues on update and skips a broken flow until it is fixed', async () => {
    const broken = await app.call('flows.update', {
      id: flowId,
      edges: [...pingPong.edges, { source: 'trigger', sourceHandle: 'exec:next', target: 'missing', targetHandle: 'exec' }],
    })
    expect(broken.issues.map((issue: any) => issue.message)).toEqual(['A connection points at a node that does not exist'])
    expect((await app.call<any[]>('flows.list')).find((flow) => flow.id === flowId)).toMatchObject({ errors: 1 })
    await say('ping')
    expect(groupReplies().at(-1)).toBe('LLM chat answered')
    await app.call('flows.update', { id: flowId, edges: pingPong.edges })
    await say('ping')
    expect(groupReplies().at(-1)).toBe('pong, user42')
  })

  it('keeps node groups, dropping missing nodes and groups left with one node', async () => {
    const flow = await app.call('flows.create', {
      ...pingPong,
      name: 'Grouped',
      groups: [{ label: 'Pair', nodes: ['trigger', 'answer', 'missing'] }, { nodes: ['answer'] }],
    })
    expect(flow.groups).toEqual([{ id: expect.any(String), label: 'Pair', nodes: ['trigger', 'answer'] }])
    const fewer = await app.call('flows.update', { id: flow.id, nodes: pingPong.nodes.slice(0, 1), edges: [] })
    expect(fewer.groups).toBeUndefined()
    await app.call('flows.delete', { id: flow.id })
  })

  it('records the model when a flow replies with an LLM answer', async () => {
    llm.setFallback({ text: 'Flow LLM answer' })
    const flow = await app.call('flows.create', {
      name: 'Ask',
      bots: [botId],
      nodes: [
        { id: 't', type: 'trigger.keyword', config: { keywords: ['ask'], mode: 'startsWith' } },
        { id: 'ai', type: 'ai.chat', label: 'Think', inputs: { prompt: '{{t.rest}}' } },
        { id: 'r', type: 'action.reply', label: 'Answer', inputs: { text: '{{ai.reply}}' } },
      ],
      edges: [
        { source: 't', sourceHandle: 'exec:next', target: 'ai', targetHandle: 'exec' },
        { source: 'ai', sourceHandle: 'exec:next', target: 'r', targetHandle: 'exec' },
      ],
    })
    await say('ask what is two plus two')
    expect(llm.requests.at(-1).messages.at(-1).content).toBe('what is two plus two')
    const reply = (await app.call<any[]>('bots.messages', { id: botId })).at(-1)
    expect(reply).toMatchObject({ segments: [{ data: { text: 'Flow LLM answer' } }] })
    expect(reply.source).toEqual({ kind: 'flow', flow: 'Ask', node: 'Answer', provider: 'Mock', model: 'mock-model' })
    await app.call('flows.delete', { id: flow.id })
    expect((await app.call<any[]>('flows.list')).map((item) => item.id)).not.toContain(flow.id)
  })
})

describe('upgrading an instance', () => {
  it('adds built-in plugins that an older config does not list', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'mushin-upgrade-'))
    const old = defaultConfig()
    old.plugins = old.plugins.filter((entry) => entry.package !== '@mushin/plugin-flows')
    old.plugins.find((entry) => entry.package === '@mushin/plugin-agent')!.enabled = false
    await writeFile(join(baseDir, 'mushin.config.json'), JSON.stringify(old))
    const instance = await start({ baseDir, port: 0, quiet: true })
    const saved = JSON.parse(await readFile(join(baseDir, 'mushin.config.json'), 'utf8'))
    expect(saved.plugins.map((entry: any) => entry.package)).toContain('@mushin/plugin-flows')
    expect(saved.plugins.find((entry: any) => entry.package === '@mushin/plugin-agent').enabled).toBe(false)
    await instance.stop()
    await rm(baseDir, { recursive: true, force: true }).catch(() => {})
  })
})
