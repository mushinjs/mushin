import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DELEGATE_TOOL, REPORT_TOOL } from '@mushinjs/plugin-fairy'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>

/** The text of a request's messages from `role`, newest last. */
const said = (request: any, role: string) => request.messages.filter((message: any) => message.role === role).map((message: any) => String(message.content))

beforeAll(async () => {
  llm = await createMockOpenAI()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
})

describe('writing to Fairy while it works', () => {
  it('reads a message sent mid-turn before its next step, without stopping the turn', async () => {
    const dashboard = await app.connect()
    const start = llm.requests.length
    llm.enqueue(
      { toolCalls: [{ name: 'bots__list', arguments: {} }], delayMs: 400 },
      { text: 'Two bots; I also checked Beta as you asked.' },
    )
    const sending = dashboard.call('fairy.send', { text: 'How many bots do I have?' })
    const started = await waitFor(() => dashboard.fairyEvents().find((event) => event.type === 'start'))
    const queued = await dashboard.call('fairy.send', { session: started.session, text: 'Also check Beta' })
    expect(queued).toEqual({ session: started.session, queued: expect.any(String) })
    expect(dashboard.fairyEvents(started.session).find((event) => event.type === 'queued')).toMatchObject({ id: queued.queued, text: 'Also check Beta' })
    await sending

    const [first, second] = llm.requests.slice(start)
    expect(said(first, 'user').at(-1)).toContain('How many bots do I have?')
    // The second request carries the tool result, then the message, marked as written mid-turn.
    expect(second.messages.at(-2).role).toBe('tool')
    expect(second.messages.at(-1)).toMatchObject({ role: 'user' })
    expect(second.messages.at(-1).content).toContain('The user wrote this while you were working')
    expect(second.messages.at(-1).content).toContain('Also check Beta')
    // The system prompt says what to do with such messages, stopping included.
    expect(second.messages[0].content).toContain('不做了')

    const events = dashboard.fairyEvents(started.session).map((event) => event.type).filter((type) => type !== 'delta')
    expect(events).toEqual(['start', 'queued', 'tool-call', 'tool-result', 'delivered', 'done'])
    const stored = await app.call('fairy.session', { id: started.session })
    expect(stored.messages.filter((message: any) => message.role === 'user').map((message: any) => message.display)).toEqual(['How many bots do I have?', 'Also check Beta'])
    dashboard.close()
  })

  it('answers a message that came in as the reply was ending', async () => {
    const dashboard = await app.connect()
    const start = llm.requests.length
    llm.enqueue(
      { text: 'Done with the first thing.', delayMs: 400 },
      { text: 'Okay, I stopped there.' },
    )
    const sending = dashboard.call('fairy.send', { text: 'Do the first thing' })
    const started = await waitFor(() => dashboard.fairyEvents().find((event) => event.type === 'start'))
    await dashboard.call('fairy.send', { session: started.session, text: '不做了' })
    await sending

    const [, second] = llm.requests.slice(start)
    expect(second.messages.at(-2)).toMatchObject({ role: 'assistant', content: 'Done with the first thing.' })
    expect(second.messages.at(-1).content).toContain('不做了')
    // One turn: one start, one done.
    const types = dashboard.fairyEvents(started.session).map((event) => event.type)
    expect(types.filter((type) => type === 'start')).toHaveLength(1)
    expect(types.filter((type) => type === 'done')).toHaveLength(1)
    dashboard.close()
  })

  it('takes a message sent while an approval waits as a decline, and passes the message on', async () => {
    const dashboard = await app.connect()
    const start = llm.requests.length
    const bots = await app.call<any[]>('bots.list')
    llm.enqueue(
      { toolCalls: [{ name: 'bots__delete', arguments: { id: bots[0]?.id ?? 'missing' } }] },
      { text: 'Okay, I left it.' },
    )
    const sending = dashboard.call('fairy.send', { text: 'Delete the first bot' })
    const confirm = await waitFor(() => dashboard.fairyEvents().find((event) => event.type === 'confirm'))
    await dashboard.call('fairy.send', { session: confirm.session, text: 'No wait, keep it' })
    await sending

    expect(dashboard.fairyEvents(confirm.session).find((event) => event.type === 'tool-result')).toMatchObject({ ok: false, error: 'Declined by the user' })
    expect((await app.call<any[]>('bots.list')).length).toBe(bots.length)
    const [, second] = llm.requests.slice(start)
    expect(second.messages.at(-2)).toMatchObject({ role: 'tool' })
    expect(second.messages.at(-2).content).toContain('they wrote a message instead')
    expect(second.messages.at(-1).content).toContain('No wait, keep it')
    dashboard.close()
  })

  it('passes a message on to a helper at work, and to Fairy after the helper reports', async () => {
    const dashboard = await app.connect()
    const start = llm.requests.length
    llm.enqueue(
      { toolCalls: [{ name: DELEGATE_TOOL, arguments: { role: 'debug', task: 'Find why the bot is quiet' } }] },
      { toolCalls: [{ name: 'logs__recent', arguments: { limit: 5 } }], delayMs: 400 },
      { toolCalls: [{ name: REPORT_TOOL, arguments: { status: 'done', summary: 'Stopped as asked.' } }] },
      { text: 'The helper stopped as you asked.' },
    )
    const sending = dashboard.call('fairy.send', { text: 'Why is my bot quiet?' })
    const helper = await waitFor(() => dashboard.fairyEvents().find((event) => event.type === 'start' && event.parent))
    await dashboard.call('fairy.send', { session: helper.parent, text: 'Stop looking, I found it' })
    await sending

    const [, , helperNext, fairyNext] = llm.requests.slice(start)
    expect(helperNext.messages.at(-1).content).toContain('The user wrote this to Fairy while you were working on the task')
    expect(helperNext.messages.at(-1).content).toContain('Stop looking, I found it')
    expect(fairyNext.messages.at(-2)).toMatchObject({ role: 'tool' })
    expect(fairyNext.messages.at(-1).content).toContain('the helper at work got it too')
    // The helper read it first; the dashboard hears of it under the conversation that started the helper.
    expect(dashboard.fairyEvents(helper.session).find((event) => event.type === 'delivered')).toMatchObject({ parent: helper.parent })
    dashboard.close()
  })

  it('still refuses to edit a message while the turn runs', async () => {
    const dashboard = await app.connect()
    llm.enqueue({ text: 'Slow answer', delayMs: 400 })
    const sending = dashboard.call('fairy.send', { text: 'Something slow' })
    const started = await waitFor(() => dashboard.fairyEvents().find((event) => event.type === 'start'))
    await expect(dashboard.call('fairy.send', { session: started.session, text: 'Edited', rewind: 0 })).rejects.toMatchObject({ code: 'conflict' })
    await sending
    dashboard.close()
  })
})
