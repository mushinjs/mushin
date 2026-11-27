import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>

/**
 * A node one-liner every shell runs alike, PowerShell and cmd included: in double quotes, with no double quote,
 * `$` or backtick inside (write strings in single quotes).
 */
const node = (code: string) => {
  if (/["$`]/.test(code)) throw new Error(`write ${code} with single quotes and no $ or backtick`)
  return `node -e "${code}"`
}

beforeAll(async () => {
  llm = await createMockOpenAI()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
  await app.call('plugins.enable', { package: '@mushinjs/plugin-terminal' })
  await waitFor(() => app.ctx.actions.has('terminal.run'))
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
})

/** Sends a message and returns its session and the dashboard that watches it, once the turn has started. */
async function start(text: string, approvals?: string) {
  const dashboard = await app.connect()
  const sending = dashboard.call('fairy.send', { text, ...(approvals ? { approvals } : {}) })
  const started = await waitFor(() => dashboard.fairyEvents().find((event) => event.type === 'start'))
  return { dashboard, sending, session: started.session as string }
}

const types = (events: any[]) => events.map((event) => event.type).filter((type) => type !== 'delta')

describe('approval modes', () => {
  it('asks in the default mode before running a command that changes something', async () => {
    llm.enqueue({ toolCalls: [{ name: 'terminal__run', arguments: { command: node("console.log('hi')") } }] }, { text: 'Ran it.' })
    const { dashboard, sending, session } = await start('Run the script')
    const confirm = await waitFor(() => dashboard.fairyEvents(session).find((event) => event.type === 'confirm'))
    await dashboard.call('fairy.confirm', { session, id: confirm.id, approved: true })
    await sending
    expect(types(dashboard.fairyEvents(session))).toEqual(['start', 'tool-call', 'confirm', 'confirmed', 'tool-result', 'done'])
    dashboard.close()
  })

  it('runs everyday commands without asking when Fairy approves for you, and asks before risky ones', async () => {
    llm.enqueue(
      { toolCalls: [{ name: 'terminal__run', arguments: { command: node("console.log('hi')") } }] },
      { toolCalls: [{ name: 'terminal__run', arguments: { command: 'rm -rf build' } }] },
      { text: 'Built; I did not delete anything.' },
    )
    const { dashboard, sending, session } = await start('Build it and clean up', 'auto')
    const confirm = await waitFor(() => dashboard.fairyEvents(session).find((event) => event.type === 'confirm'))
    expect(confirm.input).toEqual({ command: 'rm -rf build' })
    await dashboard.call('fairy.confirm', { session, id: confirm.id, approved: false })
    await sending
    const results = dashboard.fairyEvents(session).filter((event) => event.type === 'tool-result')
    expect(results[0]).toMatchObject({ ok: true, result: { code: 0 } })
    expect(results[1]).toMatchObject({ ok: false, error: 'Declined by the user' })
    expect(dashboard.fairyEvents(session).filter((event) => event.type === 'confirm')).toHaveLength(1)
    dashboard.close()
  })

  it('never asks with full access, and asks before any change when told to ask every time', async () => {
    const bot = await app.call<any>('bots.create', { name: 'Doomed', adapter: { type: 'onebot', config: { mode: 'reverse', token: 'x' } } })
    llm.enqueue({ toolCalls: [{ name: 'bots__delete', arguments: { id: bot.id } }] }, { text: 'Deleted.' })
    const full = await start('Delete Doomed', 'full')
    await full.sending
    expect(types(full.dashboard.fairyEvents(full.session))).toEqual(['start', 'tool-call', 'tool-result', 'done'])
    expect((await app.call<any[]>('bots.list')).some((item) => item.id === bot.id)).toBe(false)
    full.dashboard.close()

    const other = await app.call<any>('bots.create', { name: 'Renamed', adapter: { type: 'onebot', config: { mode: 'reverse', token: 'x' } } })
    llm.enqueue(
      { toolCalls: [{ name: 'bots__list', arguments: {} }, { name: 'bots__update', arguments: { id: other.id, name: 'Renamed again' } }] },
      { text: 'Renamed.' },
    )
    const ask = await start('Rename it', 'ask')
    const confirm = await waitFor(() => ask.dashboard.fairyEvents(ask.session).find((event) => event.type === 'confirm'))
    // Looking needs no approval; changing does.
    expect(confirm.action).toBe('bots.update')
    await ask.dashboard.call('fairy.confirm', { session: ask.session, id: confirm.id, approved: true })
    await ask.sending
    expect(ask.dashboard.fairyEvents(ask.session).filter((event) => event.type === 'confirm')).toHaveLength(1)
    ask.dashboard.close()
  })

  it('lets a waiting call go ahead when the mode switches to one that does not ask for it', async () => {
    llm.enqueue({ toolCalls: [{ name: 'terminal__run', arguments: { command: node("console.log('go')") } }] }, { text: 'Done.' })
    const { dashboard, sending, session } = await start('Run it')
    await waitFor(() => dashboard.fairyEvents(session).find((event) => event.type === 'confirm'))
    expect(await dashboard.call('fairy.approvals', { session, mode: 'auto' })).toEqual({ ok: true })
    await sending
    expect(types(dashboard.fairyEvents(session))).toEqual(['start', 'tool-call', 'confirm', 'confirmed', 'tool-result', 'done'])
    dashboard.close()
  })

  it('keeps asking for a tool set to ask in the Fairy settings, unless everything is allowed', async () => {
    await app.call('fairy.policy.set', { policies: { 'bots.list': 'confirm' } })
    try {
      llm.enqueue({ toolCalls: [{ name: 'bots__list', arguments: {} }] }, { text: 'Listed.' })
      const auto = await start('List bots', 'auto')
      const confirm = await waitFor(() => auto.dashboard.fairyEvents(auto.session).find((event) => event.type === 'confirm'))
      await auto.dashboard.call('fairy.confirm', { session: auto.session, id: confirm.id, approved: true })
      await auto.sending
      auto.dashboard.close()

      llm.enqueue({ toolCalls: [{ name: 'bots__list', arguments: {} }] }, { text: 'Listed.' })
      const full = await start('List bots', 'full')
      await full.sending
      expect(full.dashboard.fairyEvents(full.session).some((event) => event.type === 'confirm')).toBe(false)
      full.dashboard.close()
    } finally {
      await app.call('fairy.policy.set', { policies: { 'bots.list': null } })
    }
  })
})
