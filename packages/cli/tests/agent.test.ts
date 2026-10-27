import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let botId: string

// Check-in replies only: the sandbox's greeting (a reply to `/help`) can land at any point.
const checkins = async () => (await app.call<any[]>('bots.messages', { id: botId, limit: 500 }))
  .filter((record) => record.direction === 'out' && JSON.stringify(record.segments).includes('checked in'))

beforeAll(async () => {
  llm = await createMockOpenAI()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
  await app.call('plugins.enable', { package: '@mushin/plugin-demo' })
  await app.call('plugins.configure', { id: 'demo', config: { bot: true } })
  botId = (await app.call<any[]>('bots.list'))[0].id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
  await app.call('flows.create', {
    name: 'Check-in',
    bots: [botId],
    nodes: [
      { id: 'cmd', type: 'trigger.command', config: { name: 'checkin', description: 'Daily check-in' } },
      { id: 'say', type: 'action.reply', config: { text: 'checked in {{cmd.rest}}' } },
    ],
    edges: [{ source: 'cmd', sourceHandle: 'exec:next', target: 'say', targetHandle: 'exec' }],
  })
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
})

describe('agent scenes and skills', () => {
  it('puts the scene and the picked skill into the user message, and tags the conversation', async () => {
    llm.enqueue({ text: 'Looking at the logs.' })
    const { session } = await app.call('agent.send', {
      text: 'Why is it offline?',
      page: `/bots/${botId}`,
      scene: { key: 'botDetail', label: 'Bot · Demo (offline)', hint: 'Diagnose the connection', state: { status: 'offline' }, resource: `bot:${botId}` },
      skills: ['diagnose-bot'],
    })
    const sent = llm.requests.at(-1).messages
    const user = sent.at(-1).content as string
    expect(user).toMatch(/^<context>Dashboard page: \/bots\/\S+\. Page: Bot · Demo \(offline\)\. status: offline\./)
    expect(user).toContain('On this page: Diagnose the connection</context>')
    expect(user).toContain('<skill name="排查机器人连接">\n1. 用 bots.list')
    expect(user.endsWith('\n\nWhy is it offline?')).toBe(true)
    // The system prompt does not change with the scene.
    expect(sent[0].content).not.toContain('Diagnose the connection')

    const stored = await app.call('agent.session', { id: session })
    expect(stored.scene).toEqual({ key: 'botDetail', label: 'Bot · Demo (offline)', page: `/bots/${botId}` })
    expect(stored.tags).toEqual(expect.arrayContaining(['scene:botDetail', `resource:bot:${botId}`, 'skill:diagnose-bot']))
    expect(stored.messages[0]).toMatchObject({ display: 'Why is it offline?', skills: ['排查机器人连接'] })
  })

  it('lists skills and rejects unknown ones', async () => {
    const skills = await app.call<any[]>('agent.skills.list')
    expect(skills.map((skill) => skill.id)).toEqual(expect.arrayContaining(['diagnose-bot', 'build-flow', 'fix-flow', 'connect-provider']))
    expect(skills.every((skill) => skill.source === 'builtin' && skill.enabled)).toBe(true)
    await expect(app.call('agent.send', { text: 'hi', skills: ['nope'] })).rejects.toMatchObject({ code: 'not_found' })
    await expect(app.call('agent.send', { text: '  ' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('searches conversations by text and tags', async () => {
    llm.enqueue({ text: 'The check-in flow replies with a greeting.' })
    await app.call('agent.send', { text: 'Explain this flow', scene: { key: 'flowEditor', label: 'Flow editor · Check-in' } })
    expect((await app.call<any[]>('agent.search', { query: 'offline' })).map((item) => item.title)).toEqual(['Why is it offline?'])
    const byAnswer = await app.call<any[]>('agent.search', { query: 'greeting' })
    expect(byAnswer).toHaveLength(1)
    expect(byAnswer[0].snippet).toContain('greeting')
    expect((await app.call<any[]>('agent.search', { tags: ['scene:flowEditor'] })).map((item) => item.title)).toEqual(['Explain this flow'])
    expect(await app.call('agent.search', { tags: ['scene:flowEditor', 'skill:diagnose-bot'] })).toEqual([])
    expect(await app.call<any[]>('agent.search', { tags: ['status:idle'] })).toHaveLength(2)
  })
})

describe('bot commands from the Agent', () => {
  it('lists the Agent\'s own commands and every bot\'s', async () => {
    const { builtin, bots } = await app.call('agent.commands')
    expect(builtin.map((command: any) => command.name)).toEqual(['new', 'history', 'model', 'status', 'clear', 'help'])
    expect(bots).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'checkin', bot: botId, description: 'Daily check-in', source: expect.objectContaining({ kind: 'flow' }) })]))
  })

  it('only previews a command without a target', async () => {
    const before = (await checkins()).length
    const result = await app.call('bots.commands.run', { bot: botId, command: 'checkin' })
    expect(result).toMatchObject({ simulated: true, text: '/checkin' })
    expect(JSON.stringify(result.route)).toContain('checked in')
    expect((await checkins()).length).toBe(before)
  })

  it('runs a command for real as the master, in their private chat or a group', async () => {
    await expect(app.call('bots.commands.run', { bot: botId, command: '/checkin', target: 'master' })).rejects.toMatchObject({ code: 'invalid_input' })
    await app.call('permissions.update', { bot: botId, masters: ['900'] })
    expect(await app.call('bots.commands.run', { bot: botId, command: '/checkin now', target: 'master' })).toMatchObject({
      simulated: false, channel: { type: 'private', id: '900' }, user: '900', replies: ['checked in now'],
    })
    expect(await app.call('bots.commands.run', { bot: botId, command: '/checkin', target: 'group', group: '123' })).toMatchObject({
      channel: { type: 'group', id: '123' }, replies: ['checked in '],
    })
  })

  it('marks a command the Agent ran as coming from the Agent and tags the conversation', async () => {
    llm.enqueue(
      { toolCalls: [{ name: 'bots__commands__run', arguments: { bot: botId, command: '/checkin', target: 'master' } }] },
      { text: 'Done.' },
    )
    const { session } = await app.call('agent.send', { text: '/checkin for the master' })
    const incoming = (await app.call<any[]>('bots.messages', { id: botId, limit: 500 })).filter((record) => record.direction === 'in').at(-1)
    expect(incoming.source).toEqual({ kind: 'agent', session })
    expect((await app.call('agent.session', { id: session })).tags).toContain('command:checkin')
  })
})
