import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockNapCat } from './helpers/mock-napcat'

let app: TestInstance
let napcat: Awaited<ReturnType<typeof createMockNapCat>>
let botId: string

const text = (value: string) => [{ type: 'text', data: { text: value } }]
const sends = () => napcat.sent.filter((call) => call.action === 'send_private_msg' || call.action === 'send_group_msg')
const edge = (source: string, target: string) => ({ source, sourceHandle: 'exec:next', target, targetHandle: 'exec' })

beforeAll(async () => {
  napcat = await createMockNapCat({ selfId: '777' })
  app = await startInstance()
  const bot = await app.call('bots.create', { name: 'Live', adapter: { type: 'onebot', config: { mode: 'forward', url: napcat.url } } })
  botId = bot.id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
})

afterAll(async () => {
  await app?.stop()
  await napcat?.close()
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
})
