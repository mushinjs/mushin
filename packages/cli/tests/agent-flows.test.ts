import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>

const toolNames = () => llm.requests.at(-1).tools.map((tool: any) => tool.function.name) as string[]
/** The tool results the model saw in its last request, in order. */
const toolResults = () => (llm.requests.at(-1).messages as any[]).filter((message) => message.role === 'tool').map((message) => message.content as string)

beforeAll(async () => {
  llm = await createMockOpenAI()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
})

describe('Agent building flows', () => {
  it('keeps editor-only actions away from the Agent', async () => {
    llm.enqueue({ text: 'hi' })
    await app.call('agent.send', { text: 'hello' })
    const names = toolNames()
    expect(names).toContain('flows__nodeTypes')
    for (const hidden of ['flows__guide', 'flows__debug', 'flows__testOptions', 'flows__sampleMatch']) expect(names).not.toContain(hidden)
    const policies = await app.call<any[]>('agent.policy.list')
    expect(policies.some((item) => item.name === 'flows.guide')).toBe(false)
    // The dashboard still calls them.
    expect(await app.call('flows.guide', { type: 'logic.if' })).toMatchObject({ matched: true })

    llm.enqueue({ toolCalls: [{ name: 'flows__guide', arguments: { type: 'logic.if' } }] }, { text: 'okay' })
    await app.call('agent.send', { text: 'show me' })
    expect(toolResults().at(-1)).toContain('not available')
  })

  it('lists node types in one line each, whole, and gives details for the ones asked for', async () => {
    llm.enqueue({ toolCalls: [{ name: 'flows__nodeTypes', arguments: {} }] }, { text: 'listed' })
    await app.call('agent.send', { text: 'what can flows do?' })
    const catalog = toolResults().at(-1)!
    expect(catalog).not.toContain('[truncated')
    const types = JSON.parse(catalog) as any[]
    expect(types.map((type) => type.type)).toEqual(expect.arrayContaining(['trigger.command', 'onebot.sendPoke', 'onebot.findMember']))
    expect(types.find((type) => type.type === 'onebot.sendPoke')).toMatchObject({ title: 'Poke / 戳一戳', platforms: ['onebot'] })
    expect(types[0].configSchema).toBeUndefined()

    llm.enqueue({ toolCalls: [{ name: 'flows__nodeTypes', arguments: { types: ['onebot.findMember'] } }] }, { text: 'read' })
    await app.call('agent.send', { text: 'how does it work?' })
    const [detail] = JSON.parse(toolResults().at(-1)!)
    expect(detail.type).toBe('onebot.findMember')
    expect(detail.configSchema.properties.query).toBeDefined()
    expect(detail.execOut).toEqual(['found', 'notFound', 'failed'])

    // The dashboard still gets every type in full.
    expect((await app.call<any[]>('flows.nodeTypes')).find((type) => type.type === 'trigger.command').configSchema).toBeDefined()
  })

  it('points a guessed node type at the real ones', async () => {
    await expect(app.call('flows.nodeTypes', { types: ['action.poke'] })).rejects.toThrow(/No node type "action\.poke"\. Did you mean [^?]*onebot\.sendPoke/)
    await expect(app.call('flows.nodeTypes', { types: ['onebot.groupMembers'] })).rejects.toThrow(/onebot\.findMember/)
    const created = await app.call('flows.create', { name: 'Guess', nodes: [{ id: 'a', type: 'trigger.message' }, { id: 'b', type: 'data.regex' }], edges: [] })
    expect(created.issues.find((issue: any) => issue.nodeId === 'b').message).toMatch(/^Unknown node type "data\.regex"/)
    await app.call('flows.delete', { id: created.id })
  })

  it('asks the model to change course after a tool keeps failing', async () => {
    const guess = (type: string) => ({ name: 'flows__nodeTypes', arguments: { types: [type] } })
    llm.enqueue({ toolCalls: [guess('data.a'), guess('data.b'), guess('data.c')] }, { text: 'giving up' })
    await app.call('agent.send', { text: 'find a node' })
    const results = toolResults().slice(-3)
    expect(results[0]).not.toContain('Stop retrying')
    expect(results[1]).not.toContain('Stop retrying')
    expect(results[2]).toContain('has failed 3 times in this reply. Stop retrying')
  })

  it('asks for a summary on the last tool round, and says when it ran out', async () => {
    await app.call('plugins.configure', { id: 'agent', config: { maxSteps: 2 } })
    await waitFor(async () => (await app.call('agent.status').catch(() => undefined)) || undefined)
    try {
      const list = { toolCalls: [{ name: 'flows__list', arguments: {} }] }
      llm.enqueue(list, { text: 'Done so far: listed flows.' })
      await app.call('agent.send', { text: 'build it' })
      expect(toolResults().at(-1)).toContain('This was the last tool round for this message (the limit is 2)')

      const dashboard = await app.connect()
      llm.enqueue(list, list)
      await dashboard.call('agent.send', { text: 'keep going' })
      const error = await waitFor(() => dashboard.agentEvents().find((event) => event.type === 'error'))
      expect(error).toMatchObject({ code: 'max_steps', error: expect.stringContaining('Stopped after 2 tool rounds') })
      dashboard.close()
    } finally {
      await app.call('plugins.configure', { id: 'agent', config: { maxSteps: 20 } })
    }
  })
})
