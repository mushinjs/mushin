import { afterAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance | undefined

afterAll(async () => {
  await app?.stop()
})

const lastReply = async (botId: string) => (await app!.call<any[]>('bots.messages', { id: botId, limit: 50 }))
  .filter((record) => record.direction === 'out')
  .map((record) => record.segments.map((s: any) => s.data.text ?? '').join(''))
  .at(-1)

describe('database', () => {
  it('runs by default and keeps flow variables across restarts', async () => {
    app = await startInstance()
    expect(await app.call('database.status')).toMatchObject({ driver: 'sqlite', path: 'data/mushin.db' })
    await app.call('plugins.enable', { package: '@mushin/plugin-demo' })
    await app.call('plugins.configure', { id: 'demo', config: { bot: true } })
    const botId = (await app.call<any[]>('bots.list'))[0].id
    await waitFor(async () => (await app!.call('bots.get', { id: botId })).status === 'online')
    const flow = await app.call('flows.create', {
      name: 'Counter',
      bots: [botId],
      nodes: [
        { id: 'kw', type: 'trigger.keyword', config: { keywords: ['count'] } },
        { id: 'inc', type: 'data.increment', config: { name: 'n', scope: 'user' } },
        { id: 'say', type: 'action.reply', config: { text: 'n={{inc.value}}' } },
      ],
      edges: [
        { source: 'kw', sourceHandle: 'exec:next', target: 'inc', targetHandle: 'exec' },
        { source: 'inc', sourceHandle: 'exec:next', target: 'say', targetHandle: 'exec' },
      ],
    })
    await app.call('demo.say', { text: 'count', userId: '42' })
    await waitFor(async () => (await lastReply(botId)) === 'n=1')
    await app.call('demo.say', { text: 'count', userId: '42' })
    await waitFor(async () => (await lastReply(botId)) === 'n=2')
    const saved = await waitFor(async () => (await app!.call('database.rows', { table: 'flows_var', filter: { flow: flow.id } })).rows.find((row: any) => row.value === 2))
    expect(saved).toMatchObject({ flow: flow.id, bot: botId, scope: 'user', target: '42', name: 'n' })

    const { baseDir } = app
    await app.stop({ keep: true })
    app = await startInstance({ baseDir })
    await waitFor(async () => (await app!.call('bots.get', { id: botId })).status === 'online')
    await app.call('demo.say', { text: 'count', userId: '42' })
    await waitFor(async () => (await lastReply(botId)) === 'n=3')

    await app.call('flows.delete', { id: flow.id })
    expect((await app.call('database.rows', { table: 'flows_var', filter: { flow: flow.id } })).total).toBe(0)
  })
})
