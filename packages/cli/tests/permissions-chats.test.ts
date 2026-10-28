import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance
let botId: string
const GROUP = 'group:demo'

const outgoing = async () => (await app.call<any[]>('bots.messages', { id: botId, limit: 500 }))
  .filter((record) => record.direction === 'out' && record.source.kind !== 'manual')
  .map((record) => record.segments.filter((s: any) => s.type === 'text').map((s: any) => s.data.text).join(''))

/** Sends as a demo user in the demo group; returns the bot's reply. */
async function say(text: string, userId: string) {
  const before = (await outgoing()).length
  await app.call('demo.say', { text, userId, userName: `u${userId}` })
  return waitFor(async () => (await outgoing())[before])
}

beforeAll(async () => {
  app = await startInstance()
  await app.call('plugins.enable', { package: '@mushin/plugin-demo' })
  await app.call('plugins.configure', { id: 'demo', config: { bot: true, greet: false } })
  botId = (await app.call<any[]>('bots.list'))[0].id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
  await app.call('permissions.update', { bot: botId, masters: ['1'], admins: ['2'] })
  await app.call('flows.create', {
    name: 'Lottery',
    bots: [botId],
    nodes: [
      { id: 'cmd', type: 'trigger.command', config: { name: '抽奖' } },
      { id: 'check', type: 'logic.permission', config: { allow: ['user'], source: 'both' } },
      { id: 'yes', type: 'action.reply', config: { text: '抽中了' } },
      { id: 'no', type: 'action.reply', config: { text: '{{check.reason}}' } },
    ],
    edges: [
      { source: 'cmd', sourceHandle: 'exec:next', target: 'check', targetHandle: 'exec' },
      { source: 'check', sourceHandle: 'exec:allow', target: 'yes', targetHandle: 'exec' },
      { source: 'check', sourceHandle: 'exec:deny', target: 'no', targetHandle: 'exec' },
    ],
  })
})

afterAll(async () => {
  await app?.stop()
})

describe('chat members and rules', () => {
  it('keeps members with roles, tags and notes', async () => {
    const member = await app.call('permissions.members.set', { bot: botId, channel: GROUP, user: '10', tags: ['VIP', 'VIP', ' '], note: 'regular' })
    expect(member).toMatchObject({ user: '10', role: 'member', tags: ['VIP'], blocked: false, note: 'regular' })
    expect(await app.call('permissions.members.act', { bot: botId, channel: GROUP, user: '10', action: 'setAdmin' })).toMatchObject({ role: 'admin', tags: ['VIP'] })
    expect(await app.call('permissions.members.list', { bot: botId, channel: GROUP })).toHaveLength(1)
    expect(await app.call('permissions.chats', { bot: botId })).toEqual([{ channel: GROUP, members: 1, blocked: 0, rules: 0 }])
    expect(await app.call('permissions.check', { bot: botId, user: '10', group: 'demo', allow: ['chatAdmin'] })).toMatchObject({ ok: true })
    expect(await app.call('permissions.check', { bot: botId, user: '11', group: 'demo', allow: ['chatAdmin'] })).toMatchObject({ ok: false, reason: '需要本群管理，你是普通用户' })
  })

  it('applies tag rules and blocks in the permission check node', async () => {
    expect(await say('/抽奖', '11')).toBe('抽中了')
    const rule = await app.call('permissions.rules.create', { bot: botId, channel: GROUP, rule: { feature: '抽奖', effect: 'tags', tags: ['VIP'] } })
    expect(await say('/抽奖', '11')).toBe('需要标签“VIP”才能使用“抽奖”')
    expect(await say('/抽奖', '10')).toBe('抽中了')
    // Masters pass every chat rule.
    expect(await say('/抽奖', '1')).toBe('抽中了')
    await app.call('permissions.members.act', { bot: botId, channel: GROUP, user: '10', action: 'block' })
    expect(await say('/抽奖', '10')).toBe('你已被本群拉黑')
    await app.call('permissions.rules.update', { bot: botId, id: rule.id, rule: { effect: 'off', tags: [] } })
    expect(await say('/抽奖', '2')).toBe('本群已关闭“抽奖”')
    await app.call('permissions.rules.delete', { bot: botId, id: rule.id })
    await app.call('permissions.members.act', { bot: botId, channel: GROUP, user: '10', action: 'unblock' })
    expect(await say('/抽奖', '10')).toBe('抽中了')
  })

  it('lets admins manage members with chat commands once turned on', async () => {
    expect((await app.call('commands.list', { bot: botId })).commands.some((command: any) => command.name === '拉黑')).toBe(false)
    expect(await app.call('permissions.update', { bot: botId, chatCommands: true })).toMatchObject({ chatCommands: true })
    expect(await say('/拉黑 20', '11')).toBe('只有管理员可以管理本群成员')
    expect(await say('/拉黑 20', '2')).toBe('已在本群拉黑 20')
    expect(await say('/拉黑 1', '2')).toBe('不能拉黑机器人的主人')
    // Chat admins manage members, but only bot admins name chat admins.
    expect(await say('/加标签 20 VIP', '10')).toBe('已给 20 加上标签“VIP”')
    expect(await say('/设为管理 20', '10')).toBe('只有机器人的管理员可以设置本群管理')
    expect(await app.call('permissions.members.list', { bot: botId, channel: GROUP })).toEqual(expect.arrayContaining([
      expect.objectContaining({ user: '20', blocked: true, tags: ['VIP'], role: 'member' }),
    ]))
  })

  it('changes and reads members from flows, writing nothing in test runs', async () => {
    const flow = await app.call('flows.create', {
      name: 'Ban',
      bots: [botId],
      nodes: [
        { id: 'cmd', type: 'trigger.command', config: { name: 'ban', usage: '<qq>' } },
        { id: 'act', type: 'perm.member', config: { action: 'addTag', user: '{{cmd.qq}}', value: 'banned' } },
        { id: 'info', type: 'perm.memberInfo', config: { user: '{{cmd.qq}}', tag: 'banned' } },
        { id: 'say', type: 'action.reply', config: { text: '{{info.hasTag}} {{info.tags}}' } },
      ],
      edges: [
        { source: 'cmd', sourceHandle: 'exec:next', target: 'act', targetHandle: 'exec' },
        { source: 'act', sourceHandle: 'exec:next', target: 'info', targetHandle: 'exec' },
        { source: 'info', sourceHandle: 'exec:next', target: 'say', targetHandle: 'exec' },
      ],
    })
    expect(await say('/ban 30', '11')).toBe('true ["banned"]')
    const result = await app.call('flows.test', { id: flow.id, text: '/ban 31' })
    expect(result.trace.calls).toEqual([{ action: 'permissions.member', params: { channel: 'group:test', user: '31', action: 'addTag', value: 'banned' } }])
    expect(result.trace.replies).toEqual(['false '])
  })
})
