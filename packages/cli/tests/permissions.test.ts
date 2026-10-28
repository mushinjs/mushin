import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance
let botId: string

const outgoing = async () => (await app.call<any[]>('bots.messages', { id: botId, limit: 500 }))
  .filter((record) => record.direction === 'out' && record.source.kind !== 'manual')
  .map((record) => record.segments.filter((s: any) => s.type === 'text').map((s: any) => s.data.text).join(''))

/** Sends as a demo user; returns the bot's reply, or nothing when it stays silent. */
async function say(text: string, userId = '10001', quiet = false) {
  const before = (await outgoing()).length
  await app.call('demo.say', { text, userId, userName: `u${userId}` })
  if (quiet) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    return (await outgoing())[before]
  }
  return waitFor(async () => (await outgoing())[before])
}

beforeAll(async () => {
  app = await startInstance()
  await app.call('plugins.enable', { package: '@mushin/plugin-demo' })
  await app.call('plugins.configure', { id: 'demo', config: { bot: true } })
  botId = (await app.call<any[]>('bots.list'))[0].id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
})

afterAll(async () => {
  await app?.stop()
})

describe('permissions plugin', () => {
  it('moves the admins of the old command settings to the admin list', async () => {
    const bot = await app.call('bots.create', { name: 'Old', adapter: { type: 'demo', config: {} }, commands: { admins: ['777'] } })
    await waitFor(async () => (await app.call('permissions.get', { bot: bot.id })).admins.includes('777'))
    await waitFor(async () => (await app.call('bots.get', { id: bot.id })).commands?.admins === undefined)
    await app.call('bots.delete', { id: bot.id })
  })

  it('keeps masters and admins per bot, masters passing admin checks', async () => {
    expect(await app.call('permissions.update', { bot: botId, masters: ['1'], admins: ['2', '2'] })).toEqual({ masters: ['1'], admins: ['2'], chatCommands: false })
    expect(await app.call('permissions.check', { bot: botId, user: '1', allow: ['admin'] })).toMatchObject({ ok: true, role: 'master' })
    expect(await app.call('permissions.check', { bot: botId, user: '2', allow: ['admin'] })).toMatchObject({ ok: true, role: 'admin' })
    expect(await app.call('permissions.check', { bot: botId, user: '3', allow: ['admin'] })).toMatchObject({ ok: false, role: 'user', reason: '需要管理员及以上，你是普通用户' })
    expect(await app.call('permissions.check', { bot: botId, user: '2', allow: ['master'] })).toMatchObject({ ok: false })
  })

  it('branches on the permission check node in a real chat, staying silent itself', async () => {
    await app.call('flows.create', {
      name: 'Mute',
      bots: [botId],
      nodes: [
        { id: 'cmd', type: 'trigger.command', config: { name: 'mute', usage: '<qq>' } },
        { id: 'check', type: 'logic.permission', config: { allow: ['admin'] } },
        { id: 'yes', type: 'action.reply', config: { text: 'muted {{cmd.qq}}' } },
        { id: 'no', type: 'action.reply', config: { text: '{{check.reason}}' } },
      ],
      edges: [
        { source: 'cmd', sourceHandle: 'exec:next', target: 'check', targetHandle: 'exec' },
        { source: 'check', sourceHandle: 'exec:allow', target: 'yes', targetHandle: 'exec' },
        { source: 'check', sourceHandle: 'exec:deny', target: 'no', targetHandle: 'exec' },
      ],
    })
    expect(await say('/mute 99', '2')).toBe('muted 99')
    expect(await say('/mute 99', '1')).toBe('muted 99')
    expect(await say('/mute 99', '3')).toBe('需要管理员及以上，你是普通用户')
  })

  it('keeps admin and master commands from everyone else, silently', async () => {
    const flow = await app.call('flows.create', {
      name: 'Owner only',
      bots: [botId],
      nodes: [
        { id: 'cmd', type: 'trigger.command', config: { name: 'shutdown', permission: 'master' } },
        { id: 'ok', type: 'action.reply', config: { text: 'bye' } },
      ],
      edges: [{ source: 'cmd', sourceHandle: 'exec:next', target: 'ok', targetHandle: 'exec' }],
    })
    expect(await say('/shutdown', '2', true)).toBeUndefined()
    expect(await say('/shutdown', '1')).toBe('bye')
    // Test runs pretend a role.
    expect((await app.call('flows.test', { id: flow.id, text: '/shutdown', role: 'admin' })).matched).toBe(false)
    expect((await app.call('flows.test', { id: flow.id, text: '/shutdown', role: 'master' })).trace.replies).toEqual(['bye'])
  })

  it('lists only the commands the asker may run when the bot asks for it', async () => {
    await app.call('bots.update', { id: botId, commands: { helpByRole: true } })
    expect(await say('/help', '3')).not.toContain('/shutdown')
    expect(await say('/help', '1')).toContain('/shutdown')
  })

  it('tests the node with pretended roles and group roles', async () => {
    const flow = await app.call('flows.create', {
      name: 'Group admins',
      nodes: [
        { id: 'kw', type: 'trigger.keyword', config: { keywords: ['announce'] } },
        { id: 'check', type: 'logic.permission', config: { allow: ['master', 'groupAdmin'] } },
        { id: 'yes', type: 'action.reply', config: { text: 'ok' } },
        { id: 'no', type: 'action.reply', config: { text: '{{check.reason}}' } },
      ],
      edges: [
        { source: 'kw', sourceHandle: 'exec:next', target: 'check', targetHandle: 'exec' },
        { source: 'check', sourceHandle: 'exec:allow', target: 'yes', targetHandle: 'exec' },
        { source: 'check', sourceHandle: 'exec:deny', target: 'no', targetHandle: 'exec' },
      ],
    })
    const run = async (input: Record<string, unknown>) => (await app.call('flows.test', { id: flow.id, text: 'announce', ...input })).trace
    expect((await run({ groupRole: 'owner' })).replies).toEqual(['ok'])
    expect((await run({ groupRole: 'member' })).replies).toEqual(['需要主人或群管理员（含群主），你是普通用户（群成员）'])
    expect((await run({ role: 'master' })).replies).toEqual(['ok'])
    const denied = await run({ role: 'admin', private: true })
    expect(denied.steps.find((step: any) => step.nodeId === 'check')).toMatchObject({ exec: 'deny', outputs: { role: 'admin', groupRole: '' } })
  })

  it('names the plugin to enable when the node type is missing', async () => {
    await app.call('plugins.disable', { id: 'permissions' })
    const flows = await app.call<any[]>('flows.list')
    const mute = await app.call('flows.get', { id: flows.find((flow) => flow.name === 'Mute').id })
    expect(mute.issues).toEqual(expect.arrayContaining([expect.objectContaining({ plugin: '@mushin/plugin-permissions' })]))
    await app.call('plugins.enable', { package: '@mushin/plugin-permissions' })
  })
})
