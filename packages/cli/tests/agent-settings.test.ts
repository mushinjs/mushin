import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>

const toolNames = () => llm.requests.at(-1).tools.map((tool: any) => tool.function.name) as string[]

beforeAll(async () => {
  llm = await createMockOpenAI()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
})

const SKILL_MD = `---
name: Weekly report
description: "Sum up the week: messages, errors, busiest groups"
when_to_use: Every Monday
allowed-tools:
  - stats.overview
  - bots.list
scenes: [overview]
---

# Weekly report

1. Read stats.overview.
2. Write three lines.
`

describe('Agent skills', () => {
  it('creates, changes, turns off and deletes user skills', async () => {
    const skill = await app.call('agent.skills.create', { name: 'Greet the group', description: 'Say hi', instructions: 'Send hello.' })
    expect(skill).toMatchObject({ id: 'greet-the-group', source: 'user', enabled: true })
    expect(await app.call('agent.skills.update', { id: skill.id, instructions: 'Send hi.' })).toMatchObject({ instructions: 'Send hi.', name: 'Greet the group' })
    expect(await app.call('agent.skills.setEnabled', { id: skill.id, enabled: false })).toMatchObject({ enabled: false })
    expect((await app.call<any[]>('agent.skills.list')).find((item) => item.id === skill.id).enabled).toBe(false)
    await app.call('agent.skills.delete', { id: skill.id })
    await expect(app.call('agent.skills.get', { id: skill.id })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('imports and exports SKILL.md', async () => {
    const skill = await app.call('agent.skills.import', { markdown: SKILL_MD })
    expect(skill).toMatchObject({
      id: 'weekly-report',
      name: 'Weekly report',
      description: 'Sum up the week: messages, errors, busiest groups',
      whenToUse: 'Every Monday',
      tools: ['stats.overview', 'bots.list'],
      scenes: ['overview'],
    })
    expect(skill.instructions.startsWith('# Weekly report\n\n1. Read stats.overview.')).toBe(true)
    const { markdown } = await app.call('agent.skills.export', { id: skill.id })
    const back = await app.call('agent.skills.import', { markdown, replace: true })
    expect(back).toMatchObject({ id: skill.id, name: skill.name, description: skill.description, tools: skill.tools, instructions: skill.instructions })
    await expect(app.call('agent.skills.import', { markdown: 'no frontmatter, no title' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('lets built-in skills be customized, restored and turned off', async () => {
    const custom = await app.call('agent.skills.update', { id: 'diagnose-bot', instructions: 'Read the logs first.' })
    expect(custom).toMatchObject({ source: 'user', instructions: 'Read the logs first.', name: '排查机器人连接' })
    expect(await app.call('agent.skills.delete', { id: 'diagnose-bot' })).toEqual({ deleted: 'diagnose-bot', restored: true })
    expect(await app.call('agent.skills.get', { id: 'diagnose-bot' })).toMatchObject({ source: 'builtin' })
    await expect(app.call('agent.skills.delete', { id: 'diagnose-bot' })).rejects.toMatchObject({ code: 'forbidden' })
    expect(await app.call('agent.skills.setEnabled', { id: 'build-flow', enabled: false })).toMatchObject({ source: 'builtin', enabled: false })
    await app.call('agent.skills.setEnabled', { id: 'build-flow', enabled: true })
  })
})

describe('Agent page profiles', () => {
  it('keeps what the user changed per page and goes back to defaults', async () => {
    const profile = { hint: 'Only talk about flows', recommendations: [{ text: 'Make a quiz', skill: 'build-flow' }], hidden: ['flowNew'], autoShow: false }
    expect(await app.call('agent.profiles.update', { scene: 'flows', profile })).toEqual(profile)
    expect((await app.call('agent.profiles.list')).profiles.flows).toEqual(profile)
    await app.call('agent.profiles.update', { scene: 'flows', profile: null })
    expect((await app.call('agent.profiles.list')).profiles.flows).toBeUndefined()
  })
})

describe('Agent tool policy', () => {
  it('leaves tools that are off out of new conversations and refuses them in old ones', async () => {
    llm.enqueue({ text: 'first' })
    const { session } = await app.call('agent.send', { text: 'hello' })
    expect(toolNames()).toContain('bots__list')

    const policies = await app.call<any[]>('agent.policy.set', { policies: { 'bots.list': 'off' } })
    expect(policies.find((item) => item.name === 'bots.list')).toMatchObject({ policy: 'off', custom: true, plugin: expect.any(String) })
    expect(policies.find((item) => item.name === 'bots.delete')).toMatchObject({ policy: 'confirm', custom: false })
    expect((await app.call('agent.session', { id: session })).toolsStale).toBe(true)

    llm.enqueue({ toolCalls: [{ name: 'bots__list', arguments: {} }] }, { text: 'okay' })
    await app.call('agent.send', { session, text: 'list bots' })
    expect(llm.requests.at(-1).messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('turned bots__list off') })

    llm.enqueue({ text: 'new' })
    await app.call('agent.send', { text: 'new chat' })
    expect(toolNames()).not.toContain('bots__list')
    await app.call('agent.policy.set', { policies: { 'bots.list': null } })
  })

  it('asks before a tool set to confirm', async () => {
    await app.call('agent.policy.set', { policies: { 'providers.list': 'confirm' } })
    const dashboard = await app.connect()
    llm.enqueue({ toolCalls: [{ name: 'providers__list', arguments: {} }] }, { text: 'done' })
    const sending = dashboard.call('agent.send', { text: 'which providers?' })
    const confirm = await waitFor(() => dashboard.agentEvents().find((event) => event.type === 'confirm'))
    expect(confirm.action).toBe('providers.list')
    await dashboard.call('agent.confirm', { session: confirm.session, id: confirm.id, approved: true })
    await sending
    expect(dashboard.agentEvents(confirm.session).find((event) => event.type === 'tool-result')).toMatchObject({ ok: true })
    dashboard.close()
    await app.call('agent.policy.set', { policies: { 'providers.list': null } })
  })
})

describe('Agent daily budget', () => {
  it('counts tokens and stops at the budget', async () => {
    const before = await app.call('agent.usage')
    llm.enqueue({ text: 'counted' })
    await app.call('agent.send', { text: 'count me' })
    const after = await app.call('agent.usage')
    // The mock reports 10 input and 5 output tokens per reply.
    expect(after.input + after.output - before.input - before.output).toBe(15)

    await app.call('plugins.configure', { id: 'agent', config: { dailyTokens: after.input + after.output } })
    await waitFor(async () => (await app.call('agent.usage').catch(() => ({ budget: 0 }))).budget > 0)
    await expect(app.call('agent.send', { text: 'over budget' })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('daily budget') })
  })
})
