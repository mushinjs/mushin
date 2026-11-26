import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>

beforeAll(async () => {
  llm = await createMockOpenAI()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
})

describe('a glance at a conversation', () => {
  it('gives its last messages, cut short, and its last steps with how they went', async () => {
    llm.enqueue(
      { toolCalls: [{ name: 'bots__list', arguments: {} }, { name: 'flows__get', arguments: { id: 'missing' } }] },
      { text: `No bots yet. ${'x'.repeat(400)}` },
    )
    const { session } = await app.call('fairy.send', { text: 'Which bots do I have?' })
    await waitFor(async () => !(await app.call('fairy.session', { id: session })).running || undefined)
    const preview = await app.call('fairy.preview', { id: session })
    expect(preview).toMatchObject({ id: session, title: 'Which bots do I have?', running: false, total: 2 })
    expect(preview.messages.map((message: any) => message.role)).toEqual(['user', 'assistant'])
    expect(preview.messages[1].text).toHaveLength(281)
    expect(preview.steps).toEqual([{ action: 'bots.list', state: 'ok' }, { action: 'flows.get', state: 'error' }])
    expect(preview.waiting).toBeUndefined()

    llm.enqueue({ text: 'Second answer.' })
    await app.call('fairy.send', { session, text: 'And now?' })
    await waitFor(async () => !(await app.call('fairy.session', { id: session })).running || undefined)
    const last = await app.call('fairy.preview', { id: session, count: 2 })
    expect(last.total).toBe(4)
    expect(last.messages.map((message: any) => message.text)).toEqual(['And now?', 'Second answer.'])
    await app.call('fairy.deleteSession', { id: session })
  })

  it('says what a conversation at work waits on you for', async () => {
    llm.enqueue({ toolCalls: [{ name: 'bots__delete', arguments: { id: 'nope' } }] }, { text: 'Left it.' })
    const dashboard = await app.connect()
    const sending = dashboard.call('fairy.send', { text: 'Delete that bot' })
    const confirm = await waitFor(() => dashboard.fairyEvents().find((event) => event.type === 'confirm'))
    const preview = await app.call('fairy.preview', { id: confirm.session })
    expect(preview).toMatchObject({ running: true, waiting: { action: 'bots.delete' } })
    expect(preview.steps).toEqual([{ action: 'bots.delete', state: 'running' }])
    await dashboard.call('fairy.confirm', { session: confirm.session, id: confirm.id, approved: false })
    await sending
    await app.call('fairy.deleteSession', { id: confirm.session })
  })
})
