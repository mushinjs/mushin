import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance
let botId: string

const outgoing = async () => (await app.call<any[]>('bots.messages', { id: botId, limit: 200 }))
  .filter((record) => record.direction === 'out')
  .map((record) => record.segments.map((s: any) => s.data.text ?? '').join(''))

const say = (text: string, userId = '42') => app.call('demo.say', { text, userId, userName: `u${userId}` })

const command = (name: string, nodes: any[]) => ({
  name,
  bots: [botId],
  nodes: [{ id: 'cmd', type: 'trigger.command', config: { name } }, ...nodes],
  edges: nodes.map((node, index) => ({ source: index ? nodes[index - 1].id : 'cmd', sourceHandle: index ? `exec:${node.after ?? 'next'}` : 'exec:next', target: node.id, targetHandle: 'exec' })),
})

beforeAll(async () => {
  app = await startInstance()
  await app.call('plugins.enable', { package: '@mushin/plugin-demo' })
  await app.call('plugins.configure', { id: 'demo', config: { bot: true, greet: false } })
  botId = (await app.call<any[]>('bots.list'))[0].id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
  await app.call('flows.create', command('等', [
    { id: 'wait', type: 'logic.waitReply', config: { who: 'sender', seconds: 60 } },
    { id: 'say', type: 'action.reply', config: { text: '收到 {{wait.text}}' }, after: 'reply' },
  ]))
  await app.call('flows.create', command('你好', [{ id: 'say', type: 'action.reply', config: { text: '你好呀' } }]))
})

afterAll(async () => {
  await app?.stop()
})

describe('run monitoring', () => {
  it('shows what the bot is doing and lists finished runs', async () => {
    expect((await app.call('flows.activity', { bot: botId })).bots).toEqual([{ botId, state: 'idle', count: 0 }])
    await say('/你好')
    await waitFor(async () => (await outgoing()).includes('你好呀'))
    const { runs } = await waitFor(async () => {
      const page = await app.call('flows.history', { bot: botId })
      return page.runs[0]?.status === 'ok' ? page : undefined
    })
    expect(runs[0]).toMatchObject({ flowName: '你好', source: 'message', text: '/你好', user: { id: '42', name: 'u42' }, channel: 'group:demo', node: { id: 'say', type: 'action.reply' } })
    const run = await app.call('flows.run', { id: runs[0].id })
    expect(run.trace.steps.map((step: any) => step.nodeId)).toEqual(['cmd', 'say'])
    expect(run.trace.replies).toEqual(['你好呀'])
    // Saved in the database.
    expect((await app.call('database.rows', { table: 'flows_run' })).rows).toEqual([expect.objectContaining({ id: runs[0].id, status: 'ok' })])
  })

  it('stops a waiting run, which then lets the next message through', async () => {
    await say('/等')
    const activity = await waitFor(async () => {
      const result = await app.call('flows.activity', { bot: botId })
      return result.bots[0].run?.status === 'waiting' ? result : undefined
    })
    expect(activity.bots[0]).toMatchObject({ state: 'replying', count: 1, run: { flowName: '等', node: { id: 'wait' } } })
    const id = activity.runs[0].id
    expect((await app.call('flows.history', { bot: botId, status: ['running'] })).runs.map((run: any) => run.id)).toEqual([id])
    expect(await app.call('flows.stop', { id })).toMatchObject({ id, stoppedBy: 'dashboard' })
    const stopped = await waitFor(async () => {
      const run = await app.call('flows.run', { id })
      return run.status === 'stopped' ? run : undefined
    })
    expect(stopped.error).toBe('Stopped by dashboard')
    expect((await app.call('flows.activity', { bot: botId })).bots[0].state).toBe('idle')
    await expect(app.call('flows.stop', { id })).rejects.toMatchObject({ code: 'not_found' })
    // The stopped wait no longer takes this user's next message.
    await say('/你好')
    await waitFor(async () => (await outgoing()).filter((text) => text === '你好呀').length === 2)
    expect(await outgoing()).not.toContain('收到 /你好')
    const page = await app.call('flows.history', { bot: botId, status: ['stopped', 'error'] })
    expect(page.runs.map((run: any) => run.id)).toEqual([id])
  })

  it('pages back through finished runs', async () => {
    const first = await app.call('flows.history', { bot: botId, limit: 1 })
    expect(first).toMatchObject({ more: true, runs: [{ flowName: '你好' }] })
    const next = await app.call('flows.history', { bot: botId, limit: 5, before: first.runs[0].startedAt })
    expect(next.runs.map((run: any) => run.flowName)).toEqual(['等', '你好'])
    expect(next.more).toBe(false)
  })
})
