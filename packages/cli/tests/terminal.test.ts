import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance

const flow = (command: string) => ({
  name: 'Uptime',
  nodes: [
    { id: 't', type: 'trigger.keyword', config: { keywords: ['uptime'], mode: 'exact' } },
    { id: 'run', type: 'terminal.local', config: { command } },
    { id: 'say', type: 'action.reply', config: { text: '{{run.stdout}}' } },
  ],
  edges: [
    { source: 't', sourceHandle: 'exec:next', target: 'run', targetHandle: 'exec' },
    { source: 'run', sourceHandle: 'exec:ok', target: 'say', targetHandle: 'exec' },
  ],
})

beforeAll(async () => {
  app = await startInstance()
  await app.call('plugins.enable', { package: '@mushin/plugin-terminal' })
  await waitFor(async () => (await app.call<any[]>('flows.nodeTypes')).some((type) => type.type === 'terminal.local'))
})

afterAll(async () => {
  await app?.stop()
})

describe('terminal plugin', () => {
  it('adds restricted terminal nodes', async () => {
    const types = await app.call<any[]>('flows.nodeTypes')
    expect(types.filter((type) => type.type.startsWith('terminal.')).map((type) => [type.type, type.restricted])).toEqual([
      ['terminal.local', true],
      ['terminal.ssh', true],
    ])
  })

  it('lets people add terminal nodes but not the Agent', async () => {
    const actions = app.ctx.actions
    await expect(actions.call('flows.create', flow('uptime'), { kind: 'agent' })).rejects.toThrow(/Agent cannot add or change "terminal.local"/)

    const created = await app.call('flows.create', flow('uptime'))
    // The Agent can still edit the rest of the flow when it sends the terminal node back unchanged…
    const nodes = created.nodes.map((node: any) => (node.id === 'say' ? { ...node, config: { text: 'Up: {{run.stdout}}' } } : node))
    const updated: any = await actions.call('flows.update', { id: created.id, nodes }, { kind: 'agent' })
    expect(updated.nodes.find((node: any) => node.id === 'say').config.text).toBe('Up: {{run.stdout}}')
    // …but not change its command.
    const changed = nodes.map((node: any) => (node.id === 'run' ? { ...node, config: { command: 'rm -rf ~' } } : node))
    await expect(actions.call('flows.update', { id: created.id, nodes: changed }, { kind: 'agent' })).rejects.toThrow(/Agent cannot/)
  })

  it('shows the command instead of running it in a test run', async () => {
    const created = await app.call('flows.create', flow('echo {{sys.text}}'))
    const { trace } = await app.call('flows.test', { id: created.id, text: 'uptime' })
    const step = trace.steps.find((item: any) => item.nodeId === 'run')
    expect(step.outputs.stdout).toMatch(/^\[test run, not executed\] local \w+: echo '?uptime'?$/)
  })
})
