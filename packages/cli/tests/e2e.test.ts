import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockNapCat } from './helpers/mock-napcat'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let napcat: Awaited<ReturnType<typeof createMockNapCat>>
let providerId: string
let botA: string
let botB: string

const lastSent = (action: string) => [...napcat.sent].reverse().find((call) => call.action === action)

beforeAll(async () => {
  llm = await createMockOpenAI()
  napcat = await createMockNapCat({ token: 'nap-token' })
  app = await startInstance()
})

afterAll(async () => {
  await app?.stop()
  await napcat?.close()
  await llm?.close()
})

describe('plugin tree', () => {
  it('loads every app plugin from the default config', async () => {
    const plugins = await app.call<any[]>('plugins.list')
    expect(plugins.map((p) => p.status)).toEqual(plugins.map(() => 'active'))
    expect(plugins.map((p) => p.id)).toContain('adapter-onebot')
  })

  it('rejects API calls without the admin token', async () => {
    const response = await fetch(`${app.base}/api/actions`)
    expect(response.status).toBe(401)
  })

  it('refuses to disable an essential plugin', async () => {
    await expect(app.call('plugins.disable', { id: 'bots' })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('disables, re-enables and reloads an app plugin, and saves the change', async () => {
    const typeIds = async () => (await app.call<any[]>('providers.types')).map((type) => type.id).sort()
    expect(await typeIds()).toEqual(['anthropic', 'openai'])

    expect(await app.call('plugins.disable', { id: 'provider-anthropic' })).toMatchObject({ enabled: false, status: 'disabled' })
    expect(await typeIds()).toEqual(['openai'])
    const saved = JSON.parse(await readFile(join(app.baseDir, 'mushin.config.json'), 'utf8'))
    expect(saved.plugins.find((entry: any) => entry.id === 'provider-anthropic').enabled).toBe(false)

    await app.call('plugins.enable', { package: '@mushin/plugin-provider-anthropic' })
    await waitFor(async () => (await typeIds()).length === 2)
    await app.call('plugins.reload', { id: 'provider-anthropic' })
    await waitFor(async () => (await app.call<any[]>('plugins.list')).find((p) => p.id === 'provider-anthropic').status === 'active')
    expect(await typeIds()).toEqual(['anthropic', 'openai'])
  })

  it('lists bot plugins in the catalog', async () => {
    const catalog = await app.call<any[]>('plugins.catalog', { kind: 'bot' })
    expect(catalog.map((entry) => entry.package).sort()).toEqual(['@mushin/bot-plugin-echo', '@mushin/bot-plugin-llm-chat'])
    const server = (await app.call<any[]>('plugins.list')).find((p) => p.id === 'server')
    expect(server.manifest).toMatchObject({ essential: true })
  })
})

describe('providers', () => {
  it('creates a provider with a masked key and passes its test', async () => {
    const provider = await app.call('providers.create', {
      name: 'Mock',
      type: 'openai',
      config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' },
      models: ['mock-model'],
    })
    providerId = provider.id
    expect(provider.config.apiKey).toBe('sk-…7890')
    expect(provider.isDefault).toBe(true)
    const test = await app.call('providers.test', { id: providerId })
    expect(test).toMatchObject({ ok: true, model: 'mock-model' })
    expect((await app.call('providers.list')).ready).toBe(true)
  })

  it('keeps the stored key when an update sends the masked value back', async () => {
    const [record] = (await app.call('providers.list')).providers
    await app.call('providers.update', { id: providerId, config: { ...record.config } })
    const stored = app.ctx.llm.get(providerId)
    expect(stored.config.apiKey).toBe('sk-test-1234567890')
  })

  it('fetches the live model list', async () => {
    expect(await app.call('providers.models', { provider: providerId })).toEqual(['mock-model'])
  })
})

describe('bots over OneBot', () => {
  it('connects a forward-mode bot to NapCat', async () => {
    const bot = await app.call('bots.create', {
      name: 'Alpha',
      adapter: { type: 'onebot', config: { mode: 'forward', url: napcat.url, token: 'nap-token' } },
      plugins: [{ package: '@mushin/bot-plugin-echo' }],
    })
    botA = bot.id
    expect(bot.adapter.config.token).not.toBe('nap-token')
    const status = await waitFor(async () => {
      const current = await app.call('bots.get', { id: botA })
      return current.status === 'online' && current
    })
    expect(status.selfId).toBe(napcat.selfId)
  })

  it('runs a bot plugin and records provenance on the reply', async () => {
    napcat.pushGroupMessage('500', '42', [{ type: 'text', data: { text: 'echo hello there' } }])
    const call = await waitFor(() => lastSent('send_group_msg'))
    expect(call.params).toEqual({ group_id: 500, message: [{ type: 'text', data: { text: 'hello there' } }] })

    const records = await app.call<any[]>('bots.messages', { id: botA })
    const incoming = records.find((r) => r.direction === 'in')
    const reply = records.find((r) => r.direction === 'out')
    expect(incoming).toMatchObject({ type: 'text', source: { kind: 'user' }, user: { id: '42' } })
    expect(reply).toMatchObject({
      type: 'text',
      platforms: ['onebot'],
      source: { kind: 'plugin', plugin: 'echo' },
      replyTo: incoming.id,
      channel: { type: 'group', id: '500' },
    })
  })

  it('replies with the LLM when mentioned and records the model as the source', async () => {
    await app.call('bots.plugins.enable', { id: botA, package: '@mushin/bot-plugin-llm-chat' })
    llm.setFallback({ text: 'Hi from LLM' })
    const before = llm.requests.length
    napcat.pushGroupMessage('500', '42', [{ type: 'text', data: { text: 'just chatting' } }])
    napcat.pushGroupMessage('500', '42', [{ type: 'at', data: { qq: napcat.selfId } }, { type: 'text', data: { text: ' how are you?' } }])
    await waitFor(() => lastSent('send_group_msg')?.params.message[0].data.text === 'Hi from LLM')
    expect(llm.requests.length).toBe(before + 1)
    const request = llm.requests.at(-1)
    expect(request.messages.at(-1).content).toBe('user42: how are you?')
    // The unmentioned message is kept as context.
    expect(request.messages.some((m: any) => m.content === 'user42: just chatting')).toBe(true)

    const reply = (await app.call<any[]>('bots.messages', { id: botA })).at(-1)
    expect(reply.source).toMatchObject({ kind: 'llm', provider: 'Mock', model: 'mock-model', plugin: 'llm-chat' })
    expect(reply.source.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('loads a local TypeScript bot plugin from the instance plugins folder', async () => {
    const dir = join(app.baseDir, 'plugins', 'shout')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'mushin-bot-plugin-shout',
      version: '0.0.1',
      type: 'module',
      exports: { '.': './index.ts' },
      mushin: { kind: 'bot', displayName: 'Shout' },
    }))
    await writeFile(join(dir, 'index.ts'), [
      "import type { Context } from '@mushin/core'",
      "export const name = 'shout'",
      "export const inject = ['bot']",
      'export function apply(ctx: Context) {',
      '  ctx.bot.middleware(async (session, next) => {',
      "    if (!session.text.startsWith('shout ')) return next()",
      '    const loud: string = session.text.slice(6).toUpperCase()',
      '    await session.send(loud)',
      '  })',
      '}',
    ].join('\n'))

    const catalog = await app.call<any[]>('plugins.catalog', { kind: 'bot', refresh: true })
    expect(catalog.find((entry) => entry.package === 'mushin-bot-plugin-shout')).toMatchObject({ local: true })
    await app.call('bots.plugins.enable', { id: botA, package: 'mushin-bot-plugin-shout' })
    napcat.pushGroupMessage('500', '42', [{ type: 'text', data: { text: 'shout hello' } }])
    await waitFor(() => lastSent('send_group_msg')?.params.message[0].data.text === 'HELLO')
    const reply = (await app.call<any[]>('bots.messages', { id: botA })).at(-1)
    expect(reply.source).toEqual({ kind: 'plugin', plugin: 'shout' })
  })

  it('shows plugin state per bot', async () => {
    const plugins = await app.call<any[]>('bots.plugins.list', { id: botA })
    const byName = Object.fromEntries(plugins.map((p) => [p.package, p]))
    expect(byName['@mushin/bot-plugin-echo']).toMatchObject({ enabled: true, status: 'active' })
    expect(byName['mushin-bot-plugin-shout']).toMatchObject({ enabled: true, status: 'active' })
    expect(byName['@mushin/bot-plugin-llm-chat'].configSchema.properties.trigger.enum).toEqual(['mention', 'always'])
  })

  it('accepts a reverse-mode connection with the right token only', async () => {
    const bot = await app.call('bots.create', {
      name: 'Beta',
      adapter: { type: 'onebot', config: { mode: 'reverse', token: 'rev-token' } },
    })
    botB = bot.id
    const url = `ws://127.0.0.1:${app.port}/onebot/${botB}`
    await expect(napcat.connectTo(url, 'wrong')).rejects.toThrow()
    await napcat.connectTo(url, 'rev-token')
    await waitFor(async () => (await app.call('bots.get', { id: botB })).status === 'online')
  })

  it('stops one bot without touching the other', async () => {
    await app.call('bots.stop', { id: botA })
    expect((await app.call('bots.get', { id: botA })).status).toBe('offline')
    expect((await app.call('bots.get', { id: botB })).status).toBe('online')
    await app.call('bots.start', { id: botA })
    await waitFor(async () => (await app.call('bots.get', { id: botA })).status === 'online')
  })

  it('marks a bot as failed when NapCat rejects the token', async () => {
    const bot = await app.call('bots.create', {
      name: 'Gamma',
      adapter: { type: 'onebot', config: { mode: 'forward', url: napcat.url, token: 'wrong' } },
    })
    const status = await waitFor(async () => {
      const current = await app.call('bots.get', { id: bot.id })
      return current.status === 'error' && current
    })
    expect(status.error).toContain('rejected the access token')
    await app.call('bots.delete', { id: bot.id })
  })
})

describe('agent', () => {
  it('calls tools, relays navigation to the dashboard and streams the answer', async () => {
    const navigations: string[] = []
    const dashboard = await app.connect((action, input) => {
      if (action === 'ui.navigate') navigations.push(input.path)
      return { ok: true }
    })
    llm.enqueue(
      { toolCalls: [{ name: 'bots__list', arguments: {} }] },
      { toolCalls: [{ name: 'ui__navigate', arguments: { path: '/bots' } }] },
      { text: 'You have two bots.' },
    )
    const { session } = await dashboard.call('agent.send', { text: 'How many bots do I have?' })
    expect(navigations).toEqual(['/bots'])

    const events = dashboard.agentEvents(session)
    expect(events.map((e) => e.type).filter((t) => t !== 'delta')).toEqual([
      'start', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'done',
    ])
    expect(events.find((e) => e.type === 'tool-call')).toMatchObject({ action: 'bots.list', risk: 'read' })
    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'You have two bots.' })

    const first = llm.requests.at(-3)
    expect(first.messages[0].role).toBe('system')
    expect(first.messages.at(-1).content).toContain('<context>Dashboard page: /bots.')
    expect(first.tools.map((t: any) => t.function.name)).toContain('bots__plugins__enable')
    expect(first.tools.map((t: any) => t.function.name)).not.toContain('agent__send')
    // The tool result of bots.list went back to the model.
    const second = llm.requests.at(-2)
    expect(second.messages.at(-1).role).toBe('tool')
    expect(JSON.parse(second.messages.at(-1).content)).toHaveLength(2)

    const stored = await app.call('agent.session', { id: session })
    expect(stored.messages[0].display).toBe('How many bots do I have?')
    dashboard.close()
  })

  it('waits for approval before a dangerous action and honors a decline', async () => {
    const dashboard = await app.connect()
    llm.enqueue(
      { toolCalls: [{ name: 'bots__delete', arguments: { id: botB } }] },
      { text: 'Okay, I kept the bot.' },
    )
    const sending = dashboard.call('agent.send', { text: 'Delete bot Beta' })
    const confirm = await waitFor(() => dashboard.agentEvents().find((e) => e.type === 'confirm'))
    expect(confirm.action).toBe('bots.delete')
    await dashboard.call('agent.confirm', { session: confirm.session, id: confirm.id, approved: false })
    await sending
    expect((await app.call<any[]>('bots.list')).map((b) => b.id)).toContain(botB)
    expect(dashboard.agentEvents(confirm.session).find((e) => e.type === 'tool-result')).toMatchObject({ ok: false, error: 'Declined by the user' })
    dashboard.close()
  })
})
