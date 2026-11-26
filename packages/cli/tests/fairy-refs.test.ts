import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let botId: string
let flowId: string

beforeAll(async () => {
  llm = await createMockOpenAI()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
  await app.call('plugins.enable', { package: '@mushinjs/plugin-demo' })
  await app.call('plugins.configure', { id: 'demo', config: { bot: true } })
  botId = (await app.call<any[]>('bots.list'))[0].id
  await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
  flowId = (await app.call<{ id: string }>('flows.create', {
    name: 'Check-in',
    bots: [botId],
    nodes: [
      { id: 'cmd', type: 'trigger.command', config: { name: 'checkin', description: 'Daily check-in' } },
      { id: 'say', type: 'action.reply', config: { text: 'checked in {{cmd.rest}}' } },
    ],
    edges: [{ source: 'cmd', sourceHandle: 'exec:next', target: 'say', targetHandle: 'exec' }],
  })).id
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
})

/** Sends a message, waits for the reply, and returns what the model read last and the stored conversation. */
async function send(input: Record<string, unknown>) {
  llm.enqueue({ text: 'Got it.' })
  const { session } = await app.call('fairy.send', input)
  await waitFor(async () => !(await app.call('fairy.session', { id: session })).running || undefined)
  const stored = await app.call('fairy.session', { id: session })
  return { session, user: llm.requests.at(-1).messages.at(-1).content as string, stored }
}

describe('attaching things to a Fairy message', () => {
  it('reads each one as it is now, ahead of the text, and keeps their labels on the message', async () => {
    await app.call('demo.say', { text: '/checkin morning', userId: '30001', userName: 'Cat' })
    const run = await waitFor(async () => (await app.call<{ runs: any[] }>('flows.history', { flow: flowId })).runs.find((item) => item.status === 'ok'))
    const { session, user, stored } = await send({
      text: 'Why did it say that?',
      refs: [
        { kind: 'bot', id: botId, label: 'Demo bot' },
        { kind: 'flow', id: flowId },
        { kind: 'run', id: run.id, label: 'Check-in 10:00' },
        { kind: 'log', lines: ['10:00:01 WRN [bots] slow reply', '10:00:02 ERR [bots] timed out'], source: 'bots', label: '2 lines from bots' },
        { kind: 'plugin', id: '@mushinjs/plugin-demo' },
      ],
    })
    expect(user).toContain(`<ref kind="bot" id="${botId}" name="Demo bot">`)
    expect(user).toMatch(/"status":"online"/)
    expect(user).toContain(`<ref kind="flow" id="${flowId}" name="Check-in">`)
    expect(user).toMatch(/"type":"trigger\.command"/)
    expect(user).toContain(`<ref kind="run" id="${run.id}" flow="${flowId}">`)
    expect(user).toContain('checked in morning')
    expect(user).toContain('<ref kind="log" source="bots">\nThe user attached these 2 log lines from bots:\n10:00:01 WRN [bots] slow reply\n10:00:02 ERR [bots] timed out\n</ref>')
    expect(user).toContain('<ref kind="plugin" package="@mushinjs/plugin-demo"')
    expect(user.endsWith('</ref>\n\nWhy did it say that?')).toBe(true)
    expect(stored.messages[0].refs).toEqual([
      { kind: 'bot', id: botId, label: 'Demo bot' },
      { kind: 'flow', id: flowId, label: 'Check-in' },
      { kind: 'run', id: run.id, label: 'Check-in 10:00' },
      { kind: 'log', label: '2 lines from bots' },
      { kind: 'plugin', id: '@mushinjs/plugin-demo', label: expect.any(String) },
    ])
    expect(stored.tags).toEqual(expect.arrayContaining([`resource:bot:${botId}`, `resource:flow:${flowId}`, 'resource:plugin:@mushinjs/plugin-demo']))
    await app.call('fairy.deleteSession', { id: session })
  })

  it('sends with nothing but an attachment, and says so when one cannot be read', async () => {
    const { session, user, stored } = await send({ text: '', refs: [{ kind: 'flow', id: 'gone', label: 'Old flow' }, { kind: 'bot', id: botId }] })
    expect(user).toContain('<ref kind="flow" missing="true">\nThe user attached the flow "gone" (Old flow), but it could not be read:')
    expect(user).toContain(`<ref kind="bot" id="${botId}"`)
    expect(stored.title).toContain('Old flow')
    expect(stored.messages[0].refs.map((ref: any) => ref.label)).toEqual(['Old flow', expect.any(String)])
    await app.call('fairy.deleteSession', { id: session })
    await expect(app.call('fairy.send', { text: '  ' })).rejects.toThrow(/attach something/)
  })

  it('quotes a chat message given as a reference, as the quote option does', async () => {
    await app.call('demo.say', { text: '能加个天气功能吗', userId: '30002', userName: 'Dog' })
    const record = await waitFor(async () => (await app.call<any[]>('bots.messages', { id: botId, limit: 500 }))
      .find((item) => item.direction === 'in' && JSON.stringify(item.segments).includes('能加个天气功能吗')))
    const { session, user, stored } = await send({ text: 'Make this', refs: [{ kind: 'chat', bot: botId, channel: record.channel.id, id: record.id }] })
    expect(user).toContain(`<quote bot="${botId}" chat="${record.channel.id}" message="${record.id}">`)
    expect(user).toMatch(/→ \[\d\d:\d\d\] Dog \(30002\): 能加个天气功能吗/)
    expect(stored.messages[0]).toMatchObject({ quote: { focus: record.id }, refs: [{ kind: 'chat', id: record.id, label: 'Dog：能加个天气功能吗' }] })
    await app.call('fairy.deleteSession', { id: session })
  })

  it('reads a plugin\'s run on a message with the log lines it wrote', async () => {
    await app.call('demo.say', { text: '/help', userId: '30003', userName: 'Fox' })
    const run = await waitFor(async () => (await app.call<{ runs: any[] }>('bots.runs', { id: botId })).runs[0])
    const { session, user } = await send({ text: 'What happened here?', refs: [{ kind: 'run', id: run.id, bot: botId, at: run.startedAt }] })
    expect(user).toContain(`<ref kind="run" id="${run.id}" bot="${botId}">`)
    expect(user).toContain(`"plugin":"${run.plugin}"`)
    await app.call('fairy.deleteSession', { id: session })
  })
})
