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

  it('stops runs from a flow node, except its own run', async () => {
    const waiting = await app.call('flows.list').then((list: any[]) => list.find((flow) => flow.name === '等'))
    const stopper = await app.call('flows.create', command('停止', [
      { id: 'stop', type: 'logic.stopRuns', config: { flow: waiting.id } },
      { id: 'yes', type: 'action.reply', config: { text: '停止了 {{stop.count}} 个' }, after: 'stopped' },
    ]))
    await app.call('flows.update', { id: stopper.id, nodes: [...stopper.nodes, { id: 'no', type: 'action.reply', config: { text: '没有要停止的' } }], edges: [...stopper.edges, { source: 'stop', sourceHandle: 'exec:none', target: 'no', targetHandle: 'exec' }] })
    await say('/等', '43')
    await waitFor(async () => (await app.call('flows.activity', { bot: botId })).runs.some((run: any) => run.status === 'waiting'))
    await say('/停止', '44')
    await waitFor(async () => (await outgoing()).includes('停止了 1 个'))
    const [stopped] = (await app.call('flows.history', { bot: botId, status: ['stopped'] })).runs
    expect(stopped).toMatchObject({ flowName: '等', user: { id: '43' }, stoppedBy: 'flow:停止' })
    await say('/停止', '44')
    await waitFor(async () => (await outgoing()).includes('没有要停止的'))
    // Test runs list what they would stop.
    const result = await app.call('flows.test', { id: stopper.id, text: '/停止' })
    expect(result.trace.calls).toEqual([{ action: 'flows.stop', params: { flow: waiting.id, channel: 'group:test' } }])
  })

  it('pages back through finished runs', async () => {
    const first = await app.call('flows.history', { bot: botId, limit: 1 })
    expect(first).toMatchObject({ more: true, runs: [{ flowName: '停止' }] })
    const next = await app.call('flows.history', { bot: botId, limit: 5, before: first.runs[0].startedAt })
    expect(next.runs.map((run: any) => run.flowName)).toEqual(['停止', '等', '你好', '等', '你好'])
    expect(next.more).toBe(false)
  })

  it('queues runs that need a resource another run holds', async () => {
    await app.call('plugins.enable', { package: '@mushin/plugin-terminal' })
    await waitFor(async () => (await app.call<any[]>('flows.nodeTypes')).some((type) => type.type === 'terminal.local'))
    await app.call('flows.create', command('原神', [
      { id: 'run', type: 'terminal.local', label: '运行 BetterGI', config: { command: 'sleep 0.6', resource: 'game', timeout: 120 } },
      { id: 'done', type: 'action.reply', config: { text: '完成' }, after: 'ok' },
    ]))
    await say('/原神', '51')
    await waitFor(async () => (await app.call('flows.activity', { bot: botId })).runs.length === 1)
    await say('/原神', '52')
    const { runs } = await waitFor(async () => {
      const result = await app.call('flows.activity', { bot: botId })
      return result.runs.some((run: any) => run.status === 'queued') ? result : undefined
    })
    expect(runs.map((run: any) => [run.user.id, run.status])).toEqual([['52', 'queued'], ['51', 'running']])
    expect((await app.call('flows.activity', { bot: botId })).bots[0]).toMatchObject({ state: 'running', count: 2, run: { user: { id: '51' }, node: { label: '运行 BetterGI', long: true } } })
    await waitFor(async () => (await outgoing()).filter((text) => text === '完成').length === 2, 8000)
    const done = (await app.call('flows.history', { bot: botId, flow: runs[0].flowId })).runs
    expect(done.map((run: any) => [run.user.id, run.status])).toEqual([['52', 'ok'], ['51', 'ok']])
    // The second run started once the first ended.
    expect(done[0].endedAt - done[1].endedAt).toBeGreaterThanOrEqual(500)
  })

  it('pauses test runs at breakpoints, then steps, continues or stops', async () => {
    const flow = await app.call('flows.create', command('三步', [
      { id: 'a', type: 'action.reply', config: { text: '一' } },
      { id: 'b', type: 'action.reply', config: { text: '二 {{sys.text}}' } },
      { id: 'c', type: 'action.reply', config: { text: '三' } },
    ]))
    const pauses: any[] = []
    const off = app.ctx.on('flows/paused', (pause: any) => void pauses.push(pause))
    const running = app.call('flows.test', { id: flow.id, text: '/三步', breakpoints: ['a'] })
    await waitFor(() => pauses.length === 1)
    expect(pauses[0]).toMatchObject({ flowId: flow.id, nodeId: 'a', trace: { steps: [{ nodeId: 'cmd' }] } })
    await app.call('flows.debug', { runId: pauses[0].runId, action: 'step' })
    await waitFor(() => pauses.length === 2)
    expect(pauses[1]).toMatchObject({ nodeId: 'b', inputs: {}, trace: { replies: ['一'] } })
    await app.call('flows.debug', { runId: pauses[0].runId, action: 'continue' })
    expect((await running).trace.replies).toEqual(['一', '二 /三步', '三'])
    await expect(app.call('flows.debug', { runId: pauses[0].runId, action: 'continue' })).rejects.toMatchObject({ code: 'not_found' })

    const stopping = app.call('flows.test', { id: flow.id, text: '/三步', breakpoints: ['b'] })
    await waitFor(() => pauses.length === 3)
    await app.call('flows.debug', { runId: pauses[2].runId, action: 'stop' })
    expect((await stopping).trace).toMatchObject({ replies: ['一'], error: 'Stopped at a breakpoint' })
    off()
  })
})
