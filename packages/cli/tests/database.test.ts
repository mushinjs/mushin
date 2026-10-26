import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('imports the message logs once, saves new messages and pages back through a chat', async () => {
    await app?.stop()
    const baseDir = await mkdtemp(join(tmpdir(), 'mushin-test-'))
    const old = (i: number, channel: string) => ({
      id: `old${i}`, botId: 'legacy', direction: 'in', channel: { type: 'group', id: channel }, user: { id: '7', name: 'Old' },
      segments: [{ type: 'text', data: { text: `old ${i}` } }], timestamp: Date.UTC(2026, 9, 1, 0, 0, i), type: 'text', platforms: [], source: { kind: 'user' },
    })
    await mkdir(join(baseDir, 'data', 'messages', 'legacy'), { recursive: true })
    await writeFile(join(baseDir, 'data', 'messages', 'legacy', '2026-10-01.jsonl'), [0, 1, 2, 3].map((i) => JSON.stringify(old(i, i % 2 ? 'g1' : 'g2'))).join('\n') + '\nnot json\n')
    app = await startInstance({ baseDir })
    const imported = await waitFor(async () => (await app!.call('database.rows', { table: 'bots_message', filter: { bot: 'legacy' } })).total === 4)
    expect(imported).toBe(true)
    const row = (await app.call('database.rows', { table: 'bots_message', filter: { id: 'old1' } })).rows[0]
    expect(row).toMatchObject({ bot: 'legacy', channelId: 'g1', userName: 'Old', text: 'old 1' })

    // A restart imports nothing twice.
    await app.stop({ keep: true })
    app = await startInstance({ baseDir })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await app.call('database.rows', { table: 'bots_message', filter: { bot: 'legacy' } })).total).toBe(4)

    await app.call('plugins.enable', { package: '@mushin/plugin-demo' })
    await app.call('plugins.configure', { id: 'demo', config: { bot: true } })
    const botId = (await app.call<any[]>('bots.list'))[0].id
    await waitFor(async () => (await app!.call('bots.get', { id: botId })).status === 'online')
    for (const text of ['one', 'two', 'three']) await app.call('demo.say', { text, userId: '5' })
    await app.call('demo.say', { text: 'elsewhere', userId: '5', private: true })
    const incoming = async (input: object) => (await app!.call<any[]>('bots.messages', { id: botId, channel: 'demo', ...input }))
      .filter((record) => record.direction === 'in')
    const group: any[] = await waitFor(async () => {
      const list = await incoming({})
      return list.length === 3 ? list : undefined
    })
    expect(group.map((record) => record.segments[0].data.text)).toEqual(['one', 'two', 'three'])
    const older = await incoming({ before: group[2].timestamp })
    expect(older.map((record) => record.segments[0].data.text)).toEqual(['one', 'two'])
    expect((await app.call('database.rows', { table: 'bots_message', filter: { bot: botId, direction: 'in' } })).total).toBe(4)
  })
})
