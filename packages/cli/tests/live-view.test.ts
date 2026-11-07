import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockNapCat } from './helpers/mock-napcat'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let napcat: Awaited<ReturnType<typeof createMockNapCat>>
let botId: string
let llm: Awaited<ReturnType<typeof createMockOpenAI>>

const text = (value: string) => [{ type: 'text', data: { text: value } }]
const sends = () => napcat.sent.filter((call) => call.action === 'send_private_msg' || call.action === 'send_group_msg')
const edge = (source: string, target: string) => ({ source, sourceHandle: 'exec:next', target, targetHandle: 'exec' })

beforeAll(async () => {
  napcat = await createMockNapCat({ selfId: '777' })
  llm = await createMockOpenAI()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
  const bot = await app.call('bots.create', { name: 'Live', adapter: { type: 'onebot', config: { mode: 'forward', url: napcat.url } } })
  botId = bot.id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
})

afterAll(async () => {
  await app?.stop()
  await napcat?.close()
  await llm?.close()
})

describe('live conversation view', () => {
  it('lists the account\'s friends and groups, and where their pictures are', async () => {
    napcat.respond('get_friend_list', [{ user_id: 42, nickname: 'Alice', remark: 'Al' }, { user_id: 43, nickname: 'Bob', remark: '' }])
    napcat.respond('get_group_list', [{ group_id: 500, group_name: 'Tea room', member_count: 12 }])
    expect(await app.call('bots.contacts', { id: botId })).toEqual([
      { type: 'group', id: '500', name: 'Tea room', members: 12 },
      { type: 'private', id: '42', name: 'Alice', remark: 'Al' },
      { type: 'private', id: '43', name: 'Bob' },
    ])
    const adapter = (await app.call<any[]>('bots.adapters')).find((item) => item.id === 'onebot')
    expect(adapter.avatars.user).toContain('{id}')
    expect(adapter.avatars.group).toContain('{id}')
  })

  it('answers the sandbox\'s test user through flows without sending anything to the platform', async () => {
    await app.call('flows.create', {
      name: 'Ping',
      bots: [botId],
      nodes: [
        { id: 't', type: 'trigger.keyword', config: { keywords: ['ping'], mode: 'exact' } },
        { id: 'r', type: 'action.reply', config: { text: 'pong' } },
      ],
      edges: [edge('t', 'r')],
    })
    const before = sends().length
    await app.call('bots.sandbox', { id: botId, text: 'ping' })
    await waitFor(async () => (await app.call<any[]>('bots.messages', { id: botId, channel: '@sandbox', sinceStart: true })).some((record) => record.direction === 'out'))
    const records = await app.call<any[]>('bots.messages', { id: botId, channel: '@sandbox', sinceStart: true })
    expect(records.map((record) => [record.direction, record.segments.map((s: any) => s.data.text).join('')])).toEqual([['in', 'ping'], ['out', 'pong']])
    expect(records[0].user.id).toBe('@sandbox')
    expect(sends().length).toBe(before)
  })

  it('lets a keyword trigger require an @ of the bot', async () => {
    await app.call('flows.create', {
      name: 'Mentioned',
      bots: [botId],
      nodes: [
        { id: 't', type: 'trigger.keyword', config: { keywords: ['hey'], mode: 'exact', when: 'mention' } },
        { id: 'r', type: 'action.reply', config: { text: 'heard you' } },
      ],
      edges: [edge('t', 'r')],
    })
    const replies = () => sends().filter((call) => call.params.message.some((s: any) => s.data.text === 'heard you'))
    napcat.pushGroupMessage('500', '42', text('hey'))
    napcat.pushGroupMessage('500', '42', [{ type: 'at', data: { qq: '777' } }, ...text(' hey')])
    await waitFor(() => replies().length)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(replies().length).toBe(1)
  })

  it('keeps what handling a message cost: the model request, its tokens and the reply it sent', async () => {
    llm.setFallback({ text: 'four' })
    await app.call('flows.create', {
      name: 'Ask',
      bots: [botId],
      nodes: [
        { id: 't', type: 'trigger.keyword', config: { keywords: ['ask'], mode: 'startsWith' } },
        { id: 'ai', type: 'ai.chat', inputs: { prompt: '{{t.rest}}' } },
        { id: 'r', type: 'action.reply', inputs: { text: '{{ai.reply}}' } },
      ],
      edges: [edge('t', 'ai'), edge('ai', 'r')],
    })
    napcat.pushPrivateMessage('42', text('ask two plus two'))
    let records: any[] = []
    await waitFor(async () => (records = await app.call<any[]>('bots.messages', { id: botId, channel: '42', sinceStart: true })).some((record) => record.direction === 'out'))
    const asked = records.find((record) => record.direction === 'in')
    const answer = records.find((record) => record.direction === 'out')
    const cost = await app.call('bots.usage', { id: botId, message: asked.id })
    expect(cost.events).toEqual([expect.objectContaining({ kind: 'chat', provider: 'Mock', model: 'mock-model', inputTokens: 10, outputTokens: 5, ok: true })])
    expect(cost.bytes).toBeGreaterThan(0)
    expect(cost.replies).toEqual([answer.id])
    const sent = await app.call('bots.usage', { id: botId, message: answer.id })
    expect(sent).toMatchObject({ cause: asked.id, causeEvents: cost.events })
    expect(sent.sendMs).toBeGreaterThanOrEqual(0)
  })

  it('logs each message in the bot\'s log: received, the flow and model request it started, and the reply sent', async () => {
    llm.setFallback({ text: 'six' })
    napcat.pushPrivateMessage('42', text('ask three plus three'))
    const find = (lines: any[]) => {
      const received = lines.findIndex((line) => line.tag === 'message' && line.text.startsWith('received from') && line.text.endsWith('ask three plus three'))
      return received < 0 ? [] : lines.slice(received)
    }
    let lines: any[] = []
    await waitFor(async () => (lines = find(await app.call<any[]>('bots.logs', { id: botId, limit: 200 }))).some((line) => line.text.startsWith('processed in')))
    const texts = lines.map((line) => `${line.tag} ${line.text}`)
    const at = (pattern: RegExp) => texts.findIndex((text) => pattern.test(text))
    expect(at(/^message received from \S+ \(42\): ask three plus three$/)).toBe(0)
    expect(at(/^flow flow "Ask" \([\w-]+\) started by trigger\.keyword$/)).toBeGreaterThan(0)
    expect(at(/^provider chat mock-model via Mock for \S+: 10 → 5 tokens, \d+ms$/)).toBeGreaterThan(at(/started by/))
    expect(at(/^message sent to \S+ \(42\) by flow [^:]+: six \(\d+ B, \d+ms\)$/)).toBeGreaterThan(at(/^provider chat/))
    expect(at(/^flow flow "Ask" \([\w-]+\) finished in \d+ms, \d+ step\(s\), 1 reply$/)).toBeGreaterThan(at(/^message sent/))
    expect(at(/^bot processed in \d+(ms|\.\d+s)$/)).toBeGreaterThan(at(/finished in/))
  })

  it('logs platform events such as a poke in the bot\'s log', async () => {
    napcat.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 500, user_id: 46, target_id: 777 })
    await waitFor(async () => (await app.call<any[]>('bots.logs', { id: botId, limit: 200 }))
      .some((line) => line.tag === 'message' && line.text === 'event notify.poke from 46 in group 500 to 777'))
  })
})
