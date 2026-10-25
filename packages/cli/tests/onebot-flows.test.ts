import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockNapCat } from './helpers/mock-napcat'

let app: TestInstance
let napcat: Awaited<ReturnType<typeof createMockNapCat>>
let botId: string

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const text = (value: string) => [{ type: 'text', data: { text: value } }]
const sentTexts = (action: string) => napcat.sent.filter((call) => call.action === action).map((call) => call.params.message.map((s: any) => s.data.text ?? '').join(''))
const callsOf = (action: string) => napcat.sent.filter((call) => call.action === action)
const edge = (source: string, handle: string, target: string) => ({ source, sourceHandle: `exec:${handle}`, target, targetHandle: 'exec' })

async function flow(name: string, nodes: any[], edges: any[]) {
  const created = await app.call('flows.create', { name, bots: [botId], nodes, edges })
  expect(created.issues.filter((issue: any) => issue.severity === 'error')).toEqual([])
  return created
}

beforeAll(async () => {
  napcat = await createMockNapCat()
  app = await startInstance()
  const bot = await app.call('bots.create', { name: 'Groupie', adapter: { type: 'onebot', config: { mode: 'forward', url: napcat.url } } })
  botId = bot.id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
})

afterAll(async () => {
  await app?.stop()
  await napcat?.close()
})

describe('OneBot flow nodes', () => {
  it('registers the OneBot nodes with the adapter', async () => {
    const types = (await app.call<any[]>('flows.nodeTypes')).map((type) => type.type)
    expect(types).toEqual(expect.arrayContaining(['onebot.memberJoin', 'onebot.mute', 'onebot.call', 'trigger.schedule', 'logic.waitReply', 'action.send']))
  })

  it('marks OneBot nodes as needing the OneBot adapter and keeps the flow\'s adapter', async () => {
    const types = await app.call<any[]>('flows.nodeTypes')
    expect(types.find((type) => type.type === 'onebot.mute').platforms).toEqual(['onebot'])
    expect(types.find((type) => type.type === 'action.reply').platforms).toBeUndefined()
    const created = await app.call('flows.create', { name: 'Adapter', adapter: 'onebot', nodes: [{ type: 'trigger.message' }, { type: 'onebot.mute' }], edges: [edge('n1', 'next', 'n2')] })
    expect(created.adapter).toBe('onebot')
    expect(created.issues.some((issue: any) => issue.message.includes('needs a onebot bot'))).toBe(false)
    const moved = await app.call('flows.update', { id: created.id, adapter: 'demo' })
    expect(moved.issues).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'n2', severity: 'warning' })]))
    expect((await app.call('flows.update', { id: created.id, adapter: '' })).adapter).toBeUndefined()
    await app.call('flows.delete', { id: created.id })
  })

  it('welcomes a new member and mutes them, through a real NapCat connection', async () => {
    await flow('Welcome', [
      { id: 'join', type: 'onebot.memberJoin' },
      { id: 'hello', type: 'action.reply', config: { text: 'Welcome {{join.userId}}!' } },
      { id: 'mute', type: 'onebot.mute', config: { seconds: 60 } },
    ], [edge('join', 'next', 'hello'), edge('hello', 'next', 'mute')])
    napcat.push({ post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve', group_id: 500, user_id: 42, operator_id: 7 })
    await waitFor(() => callsOf('set_group_ban').length)
    expect(sentTexts('send_group_msg')).toContain('Welcome 42!')
    expect(callsOf('send_group_msg').at(-1)!.params.group_id).toBe(500)
    expect(callsOf('set_group_ban')).toEqual([{ action: 'set_group_ban', params: { group_id: 500, user_id: 42, duration: 60 } }])
  })

  it('takes the "failed" branch when NapCat refuses', async () => {
    napcat.respond('set_group_kick', { failed: true, retcode: 1400, message: 'no permission' })
    await flow('Kick', [
      { id: 'leave', type: 'onebot.memberLeave', config: { subType: 'leave' } },
      { id: 'kick', type: 'onebot.kick' },
      { id: 'sorry', type: 'action.reply', inputs: { text: 'kick failed: {{kick.error}}' } },
    ], [edge('leave', 'next', 'kick'), edge('kick', 'failed', 'sorry')])
    napcat.push({ post_type: 'notice', notice_type: 'group_decrease', sub_type: 'leave', group_id: 500, user_id: 43, operator_id: 43 })
    await waitFor(() => sentTexts('send_group_msg').some((value) => value.startsWith('kick failed')))
    expect(sentTexts('send_group_msg').at(-1)).toContain('no permission')
  })

  it('approves a friend request with the flag from the event', async () => {
    await flow('Friends', [
      { id: 'ask', type: 'onebot.friendRequest' },
      { id: 'ok', type: 'onebot.handleRequest', config: { remark: 'from flow' } },
    ], [edge('ask', 'next', 'ok')])
    napcat.push({ post_type: 'request', request_type: 'friend', user_id: 44, comment: 'hi', flag: 'flag-44' })
    const call = await waitFor(() => callsOf('set_friend_add_request')[0])
    expect(call.params).toEqual({ flag: 'flag-44', approve: true, remark: 'from flow' })
  })

  it('reports the text of a recalled message from the message log', async () => {
    await flow('Anti-recall', [
      { id: 'r', type: 'onebot.recall' },
      { id: 'say', type: 'action.reply', config: { text: '{{r.userId}} recalled: {{r.text}}' } },
    ], [edge('r', 'next', 'say')])
    const id = napcat.pushGroupMessage('500', '45', text('my secret'))
    await waitFor(async () => (await app.call<any[]>('bots.messages', { id: botId })).some((record) => record.messageId === String(id)))
    napcat.push({ post_type: 'notice', notice_type: 'group_recall', group_id: 500, user_id: 45, operator_id: 45, message_id: id })
    await waitFor(() => sentTexts('send_group_msg').includes('45 recalled: my secret'))
  })

  it('answers a private poke in the private chat', async () => {
    await flow('Poke back', [
      { id: 'p', type: 'onebot.poke', config: { where: 'private' } },
      { id: 'back', type: 'onebot.sendPoke' },
      { id: 'say', type: 'action.reply', config: { text: 'ouch' } },
    ], [edge('p', 'next', 'back'), edge('back', 'ok', 'say')])
    napcat.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 46, sender_id: 46, target_id: Number(napcat.selfId) })
    await waitFor(() => sentTexts('send_private_msg').includes('ouch'))
    expect(callsOf('friend_poke')[0].params).toEqual({ user_id: 46 })
    expect(callsOf('send_private_msg').at(-1)!.params.user_id).toBe(46)
  })

  it('keeps the sender role and replies to temporary chats with their group', async () => {
    await flow('Role', [
      { id: 'k', type: 'trigger.keyword', config: { keywords: ['whoami'], mode: 'exact' } },
      { id: 'role', type: 'onebot.senderRole' },
      { id: 'admin', type: 'action.reply', config: { text: 'you are an admin' } },
      { id: 'member', type: 'action.reply', config: { text: 'you are a member' } },
    ], [edge('k', 'next', 'role'), edge('role', 'admin', 'admin'), edge('role', 'member', 'member')])
    napcat.pushGroupMessage('500', '47', text('whoami'), { role: 'admin' })
    await waitFor(() => sentTexts('send_group_msg').includes('you are an admin'))
    const record = (await app.call<any[]>('bots.messages', { id: botId })).findLast((item) => item.user.id === '47')
    expect(record.user.role).toBe('admin')

    napcat.pushTempMessage('500', '48', text('whoami'))
    const reply = await waitFor(() => callsOf('send_private_msg').find((call) => call.params.user_id === 48))
    expect(reply.params.group_id).toBe(500)
  })

  it('waits for the answer, which does not start other flows', async () => {
    await flow('Quiz', [
      { id: 'q', type: 'trigger.keyword', config: { keywords: ['/quiz'], mode: 'exact' } },
      { id: 'ask', type: 'action.reply', config: { text: 'How many seasons?' } },
      { id: 'w', type: 'logic.waitReply', config: { seconds: 10 } },
      { id: 'got', type: 'action.reply', config: { text: 'You said {{w.text}}' } },
    ], [edge('q', 'next', 'ask'), edge('ask', 'next', 'w'), edge('w', 'reply', 'got')])
    await flow('Four', [
      { id: 'k', type: 'trigger.keyword', config: { keywords: ['4'], mode: 'exact' } },
      { id: 'r', type: 'action.reply', config: { text: 'four flow ran' } },
    ], [edge('k', 'next', 'r')])
    napcat.pushGroupMessage('501', '49', text('/quiz'))
    await waitFor(() => sentTexts('send_group_msg').includes('How many seasons?'))
    // Someone else answering does not end the wait for the sender.
    napcat.pushGroupMessage('501', '50', text('4'))
    await waitFor(() => sentTexts('send_group_msg').includes('four flow ran'))
    napcat.pushGroupMessage('501', '49', text('4'))
    await waitFor(() => sentTexts('send_group_msg').includes('You said 4'))
    await sleep(200)
    expect(sentTexts('send_group_msg').filter((value) => value === 'four flow ran')).toHaveLength(1)
  })

  it('fires schedule triggers and sends to the configured chat', async () => {
    await flow('Tick', [
      { id: 's', type: 'trigger.schedule', config: { mode: 'interval', minutes: 1, targetType: 'group', targetId: '700' } },
      { id: 'say', type: 'action.reply', config: { text: 'tick at {{s.time}}' } },
    ], [edge('s', 'next', 'say')])
    const now = Date.now()
    await app.ctx.flows.tick(new Date(now))
    await app.ctx.flows.tick(new Date(now + 30_000))
    expect(callsOf('send_group_msg').filter((call) => call.params.group_id === 700)).toHaveLength(0)
    await app.ctx.flows.tick(new Date(now + 61_000))
    const sent = await waitFor(() => callsOf('send_group_msg').filter((call) => call.params.group_id === 700))
    expect(sent).toHaveLength(1)
    expect(sent[0].params.message[0].data.text).toMatch(/^tick at \d\d:\d\d$/)
  })

  it('tests event flows without calling NapCat', async () => {
    const created = await flow('Test me', [
      { id: 'join', type: 'onebot.memberJoin' },
      { id: 'mute', type: 'onebot.mute', config: { seconds: 30 } },
    ], [edge('join', 'next', 'mute')])
    const before = napcat.sent.length
    const result = await app.call('flows.test', { id: created.id, event: { name: 'group_increase', data: { group_id: 900, user_id: 42, sub_type: 'approve' } } })
    expect(result.matched).toBe(true)
    expect(result.trace.calls).toEqual([{ action: 'set_group_ban', params: { group_id: 900, user_id: 42, duration: 30 } }])
    expect(napcat.sent.length).toBe(before)
  })

  it('shows the bot as offline while NapCat reports the QQ account offline', async () => {
    napcat.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 30_000, status: { online: false, good: false } })
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'error')
    napcat.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 30_000, status: { online: true, good: true } })
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
    napcat.push({ post_type: 'notice', notice_type: 'bot_offline', user_id: Number(napcat.selfId), tag: 'kicked', message: 'logged in elsewhere' })
    const bot = await waitFor(async () => {
      const value = await app.call('bots.get', { id: botId })
      return value.status === 'error' ? value : undefined
    })
    expect(bot.error).toContain('logged in elsewhere')
  })
})
