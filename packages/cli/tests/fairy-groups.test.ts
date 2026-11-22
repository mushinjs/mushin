import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DELEGATE_TOOL, REPORT_TOOL, resourceOf } from '@mushinjs/plugin-fairy'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let botId: string

beforeAll(async () => {
  llm = await createMockOpenAI()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
  await app.call('plugins.enable', { package: '@mushinjs/plugin-demo' })
  await app.call('plugins.configure', { id: 'demo', config: { bot: true } })
  botId = await waitFor(async () => (await app.call<any[]>('bots.list'))[0]?.id)
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
})

const summaryOf = async (id: string) => (await app.call<any[]>('fairy.sessions')).find((session) => session.id === id)

describe('resourceOf', () => {
  it('names what an action works on', () => {
    expect(resourceOf('bots.get', { id: 'b1' }, undefined)).toBe('bot:b1')
    expect(resourceOf('bots.logs', { id: 'b1' }, undefined)).toBe('bot:b1')
    expect(resourceOf('bots.plugins.enable', { id: 'b1', package: '@mushinjs/bot-plugin-echo' }, undefined)).toBe('plugin:@mushinjs/bot-plugin-echo')
    expect(resourceOf('flows.create', { name: 'x' }, { id: 'f1' })).toBe('flow:f1')
    expect(resourceOf('flows.list', {}, [])).toBeUndefined()
    expect(resourceOf('plugins.enable', { package: '@mushinjs/plugin-stats' }, undefined)).toBe('plugin:@mushinjs/plugin-stats')
    expect(resourceOf('plugins.reload', { id: 'stats' }, undefined, (id) => (id === 'stats' ? '@mushinjs/plugin-stats' : undefined))).toBe('plugin:@mushinjs/plugin-stats')
    expect(resourceOf('logs.recent', { limit: 5 }, [])).toBeUndefined()
  })
})

describe('Fairy conversation groups', () => {
  it('files a conversation under the group of the first thing it works on, and reuses the group', async () => {
    llm.enqueue({ toolCalls: [{ name: 'bots__get', arguments: { id: botId } }] }, { text: 'It is online.' })
    const first = (await app.call('fairy.send', { text: 'How is the bot?' })).session
    const groups = await app.call<any[]>('fairy.groups.list')
    const group = groups.find((item) => item.resource === `bot:${botId}`)
    expect(group).toMatchObject({ name: (await app.call('bots.get', { id: botId })).name })
    expect(await summaryOf(first)).toMatchObject({ group: group.id, tags: expect.arrayContaining([`resource:bot:${botId}`]) })

    llm.enqueue({ toolCalls: [{ name: 'bots__logs', arguments: { id: botId } }] }, { text: 'Nothing wrong.' })
    const second = (await app.call('fairy.send', { text: 'Any errors?' })).session
    expect((await summaryOf(second)).group).toBe(group.id)
    expect((await app.call<any[]>('fairy.groups.list')).filter((item) => item.resource === `bot:${botId}`)).toHaveLength(1)
  })

  it('files the conversation that started a helper under what the helper worked on', async () => {
    llm.enqueue(
      { toolCalls: [{ name: DELEGATE_TOOL, arguments: { role: 'setup', task: 'Turn on stats' } }] },
      { toolCalls: [{ name: 'plugins__enable', arguments: { package: '@mushinjs/plugin-stats' } }] },
      { toolCalls: [{ name: REPORT_TOOL, arguments: { status: 'done', summary: 'Stats is on.' } }] },
      { text: 'Done.' },
    )
    const { session } = await app.call('fairy.send', { text: 'Turn on stats' })
    const group = (await app.call<any[]>('fairy.groups.list')).find((item) => item.resource === 'plugin:@mushinjs/plugin-stats')
    expect(group).toMatchObject({ labels: expect.objectContaining({ en: expect.any(String) }) })
    expect((await summaryOf(session)).group).toBe(group.id)
  })

  it('renames, moves, marks done, and deletes groups without losing their conversations', async () => {
    llm.enqueue({ text: 'Hello.' })
    const { session } = await app.call('fairy.send', { text: 'Hi' })
    expect((await summaryOf(session)).group).toBeUndefined()

    const group = await app.call('fairy.groups.create', { name: 'Weather plugin' })
    await app.call('fairy.sessions.update', { id: session, group: group.id, title: 'Weather ideas' })
    expect(await summaryOf(session)).toMatchObject({ group: group.id, title: 'Weather ideas' })
    await expect(app.call('fairy.sessions.update', { id: session, group: 'nope' })).rejects.toThrow('No group')

    expect(await app.call('fairy.groups.update', { id: group.id, name: 'Weather' })).toMatchObject({ name: 'Weather' })
    await app.call('fairy.sessions.update', { id: session, done: true })
    expect((await summaryOf(session)).done).toBe(true)

    await app.call('fairy.groups.delete', { id: group.id })
    expect(await summaryOf(session)).toMatchObject({ title: 'Weather ideas', done: true })
    expect((await summaryOf(session)).group).toBeUndefined()
    expect((await app.call<any[]>('fairy.groups.list')).map((item) => item.id)).not.toContain(group.id)
  })

  it('keeps a move made while a reply is running', async () => {
    const group = await app.call('fairy.groups.create', { name: 'Busy' })
    llm.enqueue({ text: 'Slow answer.', delayMs: 400 })
    const sending = app.call('fairy.send', { text: 'Take your time' })
    const id = await waitFor(async () => (await app.call<any[]>('fairy.sessions')).find((item) => item.running)?.id)
    await app.call('fairy.sessions.update', { id, group: group.id })
    await sending
    expect((await summaryOf(id)).group).toBe(group.id)
  })
})
