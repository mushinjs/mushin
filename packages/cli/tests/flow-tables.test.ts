import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance
let botId: string

const replies = async () => (await app.call<any[]>('bots.messages', { id: botId, limit: 100 }))
  .filter((record) => record.direction === 'out')
  .map((record) => record.segments.map((s: any) => s.data.text ?? '').join(''))

beforeAll(async () => {
  app = await startInstance()
  await app.call('plugins.enable', { package: '@mushin/plugin-demo' })
  await app.call('plugins.configure', { id: 'demo', config: { bot: true, greet: false } })
  botId = (await app.call<any[]>('bots.list'))[0].id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
})

afterAll(async () => {
  await app?.stop()
})

/** `/签到`: the first time adds a row with 10 points, later times add 5. */
const checkinFlow = () => ({
  name: 'Check-in',
  bots: [botId],
  nodes: [
    { id: 'cmd', type: 'trigger.command', config: { name: '签到' } },
    { id: 'find', type: 'data.dbQuery', config: { table: '签到', where: [{ field: '用户', op: 'eq', value: '{{sys.userId}}' }], fields: ['积分'] } },
    { id: 'add', type: 'data.dbInsert', config: { table: '签到', values: [{ field: '用户', value: '{{sys.userId}}' }, { field: '积分', value: '10' }] } },
    { id: 'first', type: 'action.reply', config: { text: '首次签到，积分 10' } },
    { id: 'more', type: 'data.dbUpdate', config: { table: '签到', where: [{ field: 'id', op: 'eq', value: '{{find.id}}' }], values: [{ field: '积分', op: 'add', value: '5' }] } },
    { id: 'again', type: 'action.reply', config: { text: '签到成功，原有积分 {{find.积分}}' } },
  ],
  edges: [
    { source: 'cmd', sourceHandle: 'exec:next', target: 'find', targetHandle: 'exec' },
    { source: 'find', sourceHandle: 'exec:none', target: 'add', targetHandle: 'exec' },
    { source: 'add', sourceHandle: 'exec:next', target: 'first', targetHandle: 'exec' },
    { source: 'find', sourceHandle: 'exec:found', target: 'more', targetHandle: 'exec' },
    { source: 'more', sourceHandle: 'exec:updated', target: 'again', targetHandle: 'exec' },
  ],
})

describe('flow tables', () => {
  it('defines tables and adds fields, keeping their types', async () => {
    await app.call('flows.tables.define', { name: '签到', fields: [{ name: '用户', type: 'text' }] })
    const table = await app.call('flows.tables.define', { name: '签到', fields: [{ name: '积分', type: 'integer' }] })
    expect(table.fields).toEqual([{ name: '用户', type: 'text' }, { name: '积分', type: 'integer' }])
    await expect(app.call('flows.tables.define', { name: '签到', fields: [{ name: '积分', type: 'text' }] })).rejects.toMatchObject({ code: 'conflict' })
    await expect(app.call('flows.tables.define', { name: 'x', fields: [{ name: 'id', type: 'text' }] })).rejects.toMatchObject({ code: 'invalid_input' })
    const tables = (await app.call('database.tables')).map((item: any) => item.name)
    expect(tables).toContain('flow_签到')
  })

  it('reads, adds and updates rows from a flow', async () => {
    const flow = await app.call('flows.create', checkinFlow())
    expect(flow.issues.filter((issue: any) => issue.severity === 'error')).toEqual([])
    await app.call('demo.say', { text: '/签到', userId: '42' })
    await waitFor(async () => (await replies()).includes('首次签到，积分 10'))
    await app.call('demo.say', { text: '/签到', userId: '42' })
    await waitFor(async () => (await replies()).includes('签到成功，原有积分 10'))
    const rows = await app.call('database.rows', { table: 'flow_签到' })
    expect(rows.rows).toMatchObject([{ 用户: '42', 积分: 15 }])
    expect((await app.call('flows.tables.list')).tables).toMatchObject([{ name: '签到', rows: 1 }])
  })

  it('lists writes in test runs instead of making them', async () => {
    const [flow] = (await app.call<any[]>('flows.list')).filter((item) => item.name === 'Check-in')
    const result = await app.call('flows.test', { id: flow.id, text: '/签到', userName: 'New' })
    expect(result.trace.replies).toEqual(['首次签到，积分 10'])
    expect(result.trace.calls).toEqual([{ action: 'database.insert', params: { table: '签到', values: { 用户: '10000', 积分: 10 } } }])
    expect((await app.call('database.rows', { table: 'flow_签到' })).rows).toHaveLength(1)
  })

  it('is unavailable without the database plugin', async () => {
    const [flow] = (await app.call<any[]>('flows.list')).filter((item) => item.name === 'Check-in')
    await app.call('plugins.disable', { id: 'database', cascade: true })
    await waitFor(async () => (await app.call<any[]>('flows.nodeTypes')).find((type) => type.type === 'data.dbQuery')?.unavailable)
    const issues = (await app.call('flows.get', { id: flow.id })).issues
    expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'find', severity: 'error', message: expect.stringContaining('Database plugin') })]))
  })
})
