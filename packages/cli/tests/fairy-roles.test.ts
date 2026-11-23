import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DELEGATE_TOOL, REPORT_TOOL } from '@mushinjs/plugin-fairy'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>

const toolNames = (request: any) => request.tools.map((tool: any) => tool.function.name) as string[]

beforeAll(async () => {
  llm = await createMockOpenAI()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
})

describe('Fairy helpers', () => {
  it('hands a task to debug, which reads the logs and reports back', async () => {
    const dashboard = await app.connect()
    const start = llm.requests.length
    llm.enqueue(
      { toolCalls: [{ name: DELEGATE_TOOL, arguments: { role: 'debug', task: 'Find the error the user saw just now', context: 'The user is on /logs' } }] },
      { toolCalls: [{ name: 'logs__recent', arguments: { limit: 20 } }] },
      { toolCalls: [{ name: REPORT_TOOL, arguments: { status: 'done', summary: 'The provider key was rejected.', findings: [{ title: 'Bad key', where: 'provider Mock', fix: 'Set a new key' }, { detail: 'no title' }] } }] },
      { text: 'The provider key was rejected; set a new one.' },
    )
    const { session } = await dashboard.call('fairy.send', { text: '看看刚才的报错' })

    const [main, child, report, after] = llm.requests.slice(start)
    expect(toolNames(main)).toContain(DELEGATE_TOOL)
    const delegate = main.tools.find((tool: any) => tool.function.name === DELEGATE_TOOL).function
    expect(delegate.parameters.properties.role.enum).toEqual(['debug', 'setup', 'builder', 'developer'])
    // Without the Terminal plugin the developer cannot work; the listing says what to turn on.
    expect(delegate.description).toContain('- developer (not available yet: turn on @mushinjs/plugin-terminal first (plugins__enable), after asking the user)')
    // The helper has its own prompt and tools: read-only ones and the report, never delegation.
    expect(child.messages[0].content).toContain('You are the Debug helper of Fairy')
    expect(child.messages[1].content).toMatch(/^<task time="[^"]+">\nFind the error the user saw just now\n\nContext from Fairy:\nThe user is on \/logs\n<\/task>$/)
    const childTools = toolNames(child)
    expect(childTools).toEqual(expect.arrayContaining(['logs__recent', 'bots__logs', 'plugins__list', 'providers__test', REPORT_TOOL]))
    expect(childTools).not.toContain(DELEGATE_TOOL)
    expect(childTools).not.toContain('providers__create')
    expect(childTools).not.toContain('ui__navigate')
    expect(report.messages.at(-1)).toMatchObject({ role: 'tool' })
    // Fairy reads the report as the result of its delegate call.
    const result = JSON.parse(after.messages.at(-1).content)
    expect(result).toMatchObject({ role: 'debug', status: 'done', summary: 'The provider key was rejected.', findings: [{ title: 'Bad key', where: 'provider Mock', fix: 'Set a new key' }] })
    expect(result.findings).toHaveLength(1)

    // The helper's conversation is stored apart, linked to the task, and left out of the history list.
    const task = await app.call('fairy.session', { id: result.task })
    expect(task).toMatchObject({ role: 'debug', parent: { session }, tags: ['role:debug'], running: false })
    expect(task.messages[0].display).toBe('Find the error the user saw just now')
    expect((await app.call<any[]>('fairy.sessions')).map((item) => item.id)).not.toContain(result.task)

    // Its events name the conversation and call that started it.
    const events = dashboard.fairyEvents(result.task)
    expect(events.map((event) => event.type)).toEqual(['start', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'done'])
    expect(events.every((event) => event.parent === session && event.call === task.parent.call)).toBe(true)
    expect(dashboard.fairyEvents(session).find((event) => event.type === 'tool-result')).toMatchObject({ ok: true, result: { task: result.task } })
    dashboard.close()

    await app.call('fairy.deleteSession', { id: session })
    await expect(app.call('fairy.session', { id: result.task })).rejects.toThrow()
  })

  it('routes a helper\'s approvals to the dashboard', async () => {
    await app.call('fairy.policy.set', { policies: { 'providers.list': 'confirm' } })
    const dashboard = await app.connect()
    llm.enqueue(
      { toolCalls: [{ name: DELEGATE_TOOL, arguments: { role: 'setup', task: 'List the providers' } }] },
      { toolCalls: [{ name: 'providers__list', arguments: {} }] },
      { toolCalls: [{ name: REPORT_TOOL, arguments: { status: 'blocked', summary: 'One provider.', next: 'Ask for an API key' } }] },
      { text: 'What is your key?' },
    )
    const sending = dashboard.call('fairy.send', { text: 'set up a provider' })
    const confirm = await waitFor(() => dashboard.fairyEvents().find((event) => event.type === 'confirm'))
    expect(confirm).toMatchObject({ action: 'providers.list', parent: expect.any(String), call: expect.any(String) })
    await dashboard.call('fairy.confirm', { session: confirm.session, id: confirm.id, approved: true })
    const { session } = await sending
    const result = dashboard.fairyEvents(session).find((event) => event.type === 'tool-result')
    expect(result).toMatchObject({ ok: true, result: { role: 'setup', status: 'blocked', next: 'Ask for an API key' } })
    dashboard.close()
    await app.call('fairy.policy.set', { policies: { 'providers.list': null } })
  })

  it('tells Fairy what a helper that cannot work yet needs', async () => {
    llm.enqueue(
      { toolCalls: [{ name: DELEGATE_TOOL, arguments: { role: 'developer', task: 'Write a weather plugin' } }] },
      { text: 'Shall I turn on the Terminal plugin?' },
    )
    await app.call('fairy.send', { text: 'write a weather plugin' })
    expect(llm.requests.at(-1).messages.at(-1).content).toContain('cannot work yet: it needs files.write, files.edit, plugins.new. Ask the user whether to turn on @mushinjs/plugin-terminal')
  })

  it('tells Fairy when it names a role there is not', async () => {
    llm.enqueue(
      { toolCalls: [{ name: DELEGATE_TOOL, arguments: { role: 'nobody', task: 'x' } }] },
      { text: 'No such helper.' },
    )
    await app.call('fairy.send', { text: 'go' })
    expect(llm.requests.at(-1).messages.at(-1).content).toContain('No role "nobody"; roles: debug, setup, builder')
  })

  it('lists the roles with their tools, and takes roles from plugins', async () => {
    const roles = await app.call<any[]>('fairy.roles.list')
    expect(roles.map((role) => role.id)).toEqual(['debug', 'setup', 'builder', 'developer'])
    // The developer writes files, which needs the Terminal plugin; without it Fairy does not offer that helper.
    expect(roles.find((role) => role.id === 'developer')).toMatchObject({ ready: false, needs: ['files.write', 'files.edit', 'plugins.new'] })
    const builder = roles.find((role) => role.id === 'builder')
    expect(builder.toolNames).toEqual(expect.arrayContaining(['flows__create', 'flows__test', 'bots__list']))
    expect(builder.toolNames).not.toContain('flows__delete')
    expect(roles.find((role) => role.id === 'setup').toolNames).not.toContain('bots__send')

    const dispose = app.ctx.fairy.defineRole({ id: 'reviewer', name: 'Reviewer', description: 'Reviews flows.', instructions: 'Read flows.', tools: { include: ['flows.list', 'flows.get'] } })
    const withPlugin = await app.call<any[]>('fairy.roles.list')
    expect(withPlugin.find((role) => role.id === 'reviewer')).toMatchObject({ source: 'plugin', toolNames: ['flows__get', 'flows__list'] })
    dispose()
    expect((await app.call<any[]>('fairy.roles.list')).map((role) => role.id)).not.toContain('reviewer')
  })

  it('hands code to the developer once the Terminal plugin is on, in the same reply', async () => {
    const start = llm.requests.length
    llm.enqueue(
      { toolCalls: [{ name: 'plugins__enable', arguments: { package: '@mushinjs/plugin-terminal' } }] },
      { toolCalls: [{ name: DELEGATE_TOOL, arguments: { role: 'developer', task: 'Write a weather plugin' } }] },
      { toolCalls: [{ name: REPORT_TOOL, arguments: { status: 'done', summary: 'Wrote it.' } }] },
      { text: 'Done.' },
    )
    await app.call('fairy.send', { text: 'turn it on and write the plugin' })
    const [, , child] = llm.requests.slice(start)
    expect(child.messages[0].content).toContain('You are the Developer helper of Fairy')
    expect(toolNames(child)).toEqual(expect.arrayContaining(['files__write', 'files__edit', 'plugins__new', 'plugins__reload', 'terminal__run']))
    expect((await app.call<any[]>('fairy.roles.list')).find((role) => role.id === 'developer')).toMatchObject({ ready: true })
  })
})
