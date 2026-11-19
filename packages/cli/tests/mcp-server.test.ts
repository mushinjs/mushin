import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBridge } from '../src/mcp'
import { startInstance, type TestInstance, TOKEN } from './helpers/instance'

const KEY = 'sk-mcp-secret-0123456789'

let app: TestInstance
let seq = 0

beforeAll(async () => {
  app = await startInstance()
})

afterAll(async () => {
  await app?.stop()
})

async function post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  const response = await fetch(`${app.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : undefined }
}

async function rpc(method: string, params: unknown = {}) {
  const { status, json } = await post({ jsonrpc: '2.0', id: ++seq, method, params })
  expect(status).toBe(200)
  if (json.error) throw Object.assign(new Error(json.error.message), json.error)
  return json.result
}

async function tool(name: string, args: unknown = {}) {
  const result = await rpc('tools/call', { name, arguments: args })
  return { text: result.content[0].text as string, isError: !!result.isError }
}

const toolNames = async () => (await rpc('tools/list')).tools.map((item: any) => item.name) as string[]

describe('MCP server', () => {
  it('refuses requests without the admin token or from another site', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
    expect((await post(init, {})).status).toBe(401)
    expect((await post(init, { authorization: 'Bearer wrong-token' })).status).toBe(401)
    expect((await post(init, { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(init, { authorization: `Bearer ${TOKEN}`, origin: app.base })).status).toBe(200)
    expect((await fetch(`${app.base}/mcp`)).status).toBe(405)
  })

  it('initializes and lists a short set of tools plus search and call', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(init.protocolVersion).toBe('2025-06-18')
    expect(init.serverInfo.name).toBe('mushin')
    expect(init.capabilities.tools).toBeDefined()
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
    expect(await rpc('ping')).toEqual({})

    const names = await toolNames()
    expect(names).toEqual(expect.arrayContaining(['bots__list', 'flows__test', 'search_tools', 'call_tool']))
    // The Agent's own tools and dashboard-only actions are not offered.
    expect(names.some((name) => name.startsWith('agent__') || name.startsWith('ui__'))).toBe(false)
    // Tools not listed directly are found and run through search and call.
    expect(names).not.toContain('providers__types')
    const found = JSON.parse((await tool('search_tools', { query: 'provider types' })).text)
    expect(found.tools.map((item: any) => item.name)).toContain('providers__types')
    const types = await tool('call_tool', { name: 'providers__types', input: {} })
    expect(types.isError).toBe(false)
    expect(types.text).toContain('openai')
  })

  it('leaves out tools the policy turns off', async () => {
    await app.call('agent.policy.set', { policies: { 'bots.list': 'off' } })
    try {
      expect(await toolNames()).not.toContain('bots__list')
      const found = JSON.parse((await tool('search_tools', { query: 'bots.list' })).text)
      expect(found.tools.map((item: any) => item.name)).not.toContain('bots__list')
      const called = await tool('bots__list')
      expect(called.isError).toBe(true)
      expect(called.text).toMatch(/not_found/)
    } finally {
      await app.call('agent.policy.set', { policies: { 'bots.list': null } })
    }
  })

  it('runs a dangerous tool only after the user allows it in the dashboard', async () => {
    const created = await tool('call_tool', { name: 'providers.create', input: { name: 'Doomed', type: 'openai', config: { baseURL: 'http://127.0.0.1:9/v1', apiKey: KEY }, models: ['m'] } })
    expect(created.isError).toBe(false)
    const id = JSON.parse(created.text).id as string
    const exists = async () => (await app.call<{ providers: any[] }>('providers.list')).providers.some((item) => item.id === id)

    // No dashboard open: nothing runs.
    const alone = await tool('call_tool', { name: 'providers.delete', input: { id } })
    expect(alone.isError).toBe(true)
    expect(alone.text).toMatch(/no dashboard is open/)
    expect(await exists()).toBe(true)

    const asked: any[] = []
    let answer = 1
    const dashboard = await app.connect((action, input) => {
      asked.push({ action, input })
      return { choice: answer }
    })
    try {
      const declined = await tool('call_tool', { name: 'providers.delete', input: { id } })
      expect(declined.isError).toBe(true)
      expect(declined.text).toMatch(/declined/)
      expect(await exists()).toBe(true)
      expect(asked[0].action).toBe('ui.ask')
      expect(asked[0].input.question).toContain('providers.delete')

      answer = 0
      const allowed = await tool('call_tool', { name: 'providers.delete', input: { id } })
      expect(allowed.isError).toBe(false)
      expect(await exists()).toBe(false)
    } finally {
      dashboard.close()
    }
  })

  it('never shows a key in a tool result', async () => {
    const created = await tool('call_tool', { name: 'providers.create', input: { name: 'Keyed', type: 'openai', config: { baseURL: 'http://127.0.0.1:9/v1', apiKey: KEY }, models: ['m'] } })
    expect(created.text).not.toContain(KEY)
    const listed = await tool('call_tool', { name: 'providers.list', input: {} })
    expect(listed.text).not.toContain(KEY)
    expect(listed.text).toContain('${')
    const recent = await tool('logs__recent', { limit: 1000 })
    expect(recent.text).not.toContain(KEY)
    expect(recent.text).not.toContain(TOKEN)
  })
})

describe('mushin mcp', () => {
  async function bridge(port: number, messages: unknown[]) {
    const dir = await mkdtemp(join(tmpdir(), 'mushin-bridge-'))
    await writeFile(join(dir, 'mushin.config.json'), JSON.stringify({ plugins: [{ id: 'server', package: '@cordisjs/plugin-server', config: { port } }] }))
    const input = new PassThrough()
    const lines: any[] = []
    const done = runBridge({ baseDir: dir, input, write: (line) => lines.push(JSON.parse(line)) })
    for (const message of messages) input.write(JSON.stringify(message) + '\n')
    input.end()
    await done
    await rm(dir, { recursive: true, force: true })
    return lines
  }

  it('forwards messages to the running instance with the token from .env', async () => {
    const lines = await bridge(app.port, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ])
    expect(lines).toHaveLength(2)
    const init = lines.find((line) => line.id === 1)
    expect(init.result.serverInfo.name).toBe('mushin')
    expect(init.result.capabilities.tools.listChanged).toBe(true)
    expect(lines.find((line) => line.id === 2).result.tools.map((item: any) => item.name)).toContain('bots__list')
  })

  it('answers while Mushin.js is not running', async () => {
    const lines = await bridge(9, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bots__list', arguments: {} } },
    ])
    expect(lines.find((line) => line.id === 1).result.instructions).toMatch(/not running/)
    expect(lines.find((line) => line.id === 2).result.tools).toEqual([])
    expect(lines.find((line) => line.id === 3).result.isError).toBe(true)
  })
})
