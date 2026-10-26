import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

const MOCK = fileURLToPath(new URL('./helpers/mock-mcp.mjs', import.meta.url))

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let http: Server
let httpUrl: string
const httpRequests: { session?: string; version?: string; method: string }[] = []

/** A Streamable HTTP MCP server: JSON answers for most calls, an event stream for tools/call. */
function startHttpMcp() {
  http = createServer(async (req, res) => {
    if (req.method === 'DELETE') return res.end()
    let body = ''
    for await (const chunk of req) body += chunk
    const message = JSON.parse(body)
    httpRequests.push({ session: req.headers['mcp-session-id'] as string, version: req.headers['mcp-protocol-version'] as string, method: message.method })
    if (req.headers.authorization !== 'Bearer s3cret-token') {
      res.statusCode = 401
      return res.end('no token')
    }
    if (!message.id) {
      res.statusCode = 202
      return res.end()
    }
    const reply = (result: unknown) => JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
    if (message.method === 'initialize') {
      res.setHeader('mcp-session-id', 'sess-1')
      res.setHeader('content-type', 'application/json')
      return res.end(reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remote' } }))
    }
    if (message.method === 'tools/list') {
      res.setHeader('content-type', 'application/json')
      return res.end(reply({ tools: [{ name: 'lookup', description: 'Look a word up', inputSchema: { type: 'object', properties: { word: { type: 'string' } } } }] }))
    }
    res.setHeader('content-type', 'text/event-stream')
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`)
    res.end(`data: ${reply({ content: [{ type: 'text', text: `${message.params.arguments.word}: a word` }] })}\n\n`)
  })
  return new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => {
    httpUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`
    resolve()
  }))
}

beforeAll(async () => {
  llm = await createMockOpenAI()
  await startHttpMcp()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
  http?.close()
})

describe('MCP servers', () => {
  let serverId: string

  it('connects to a stdio server and offers its tools as actions', async () => {
    const server = await app.call('mcp.servers.create', { name: 'Mock tools', transport: 'stdio', command: process.execPath, args: [MOCK], env: { MOCK_SECRET: 'very-secret-value' } })
    serverId = server.id
    expect(server).toMatchObject({ id: 'mockTools', status: 'connected', serverInfo: { name: 'mock' }, env: { MOCK_SECRET: 'ver…alue' } })
    expect(server.tools.map((tool: any) => [tool.action, tool.risk])).toEqual([
      ['mcp.mockTools.echoText', 'write'],
      ['mcp.mockTools.add', 'read'],
      ['mcp.mockTools.fail', 'dangerous'],
    ])
    expect(server.stderr.join('\n')).toContain('with a secret')

    expect(await app.call('mcp.mockTools.echoText', { text: 'hi' })).toEqual({ text: 'echo: hi' })
    expect(await app.call('mcp.mockTools.add', { a: 2, b: 3 })).toEqual({ text: '5', structured: { sum: 5 } })
    await expect(app.call('mcp.mockTools.fail', {})).rejects.toMatchObject({ code: 'failed', message: 'it broke' })

  })

  it('picks up tools the server adds later', async () => {
    await app.call('mcp.mockTools.echoText', { text: 'grow' })
    await waitFor(async () => (await app.call<any[]>('mcp.servers.list'))[0].tools.some((tool: any) => tool.name === 'grow'))
    expect(await app.call('mcp.mockTools.grow', {})).toEqual({ text: 'grown' })
  })

  it('turns single tools off and keeps secrets that come back masked', async () => {
    const updated = await app.call('mcp.tools.update', { id: serverId, tool: 'fail', enabled: false })
    expect(updated.tools.find((tool: any) => tool.name === 'fail').enabled).toBe(false)
    await expect(app.call('mcp.mockTools.fail', {})).rejects.toMatchObject({ code: 'not_found' })
    const listed = (await app.call<any[]>('mcp.servers.list'))[0]
    const again = await app.call('mcp.servers.update', { id: serverId, env: listed.env })
    expect(again.status).toBe('connected')
    expect(again.stderr.join('\n')).toContain('with a secret')
  })

  it('talks Streamable HTTP with a session id and event streams', async () => {
    const server = await app.call('mcp.servers.create', { name: 'Remote', transport: 'http', url: httpUrl, headers: { authorization: 'Bearer s3cret-token' } })
    expect(server).toMatchObject({ status: 'connected', headers: { authorization: 'Bea…oken' } })
    expect(await app.call('mcp.remote.lookup', { word: 'mushin' })).toEqual({ text: 'mushin: a word' })
    expect(httpRequests.find((request) => request.method === 'tools/call')).toMatchObject({ session: 'sess-1', version: '2025-06-18' })
  })

  it('reports a server it cannot reach', async () => {
    const server = await app.call('mcp.servers.create', { name: 'Locked', transport: 'http', url: httpUrl, headers: { authorization: 'Bearer wrong' } })
    expect(server.status).toBe('error')
    expect(server.error).toContain('401')
  })

  it('gives the Agent the tools in new conversations and removes them with the server', async () => {
    llm.enqueue({ text: 'ok' })
    await app.call('agent.send', { text: 'hello' })
    const names = llm.requests.at(-1).tools.map((tool: any) => tool.function.name)
    expect(names).toEqual(expect.arrayContaining(['mcp__mockTools__echoText', 'mcp__remote__lookup']))
    expect(llm.requests.at(-1).tools.find((tool: any) => tool.function.name === 'mcp__mockTools__echoText').function.parameters).toMatchObject({ required: ['text'] })

    await app.call('mcp.servers.delete', { id: serverId })
    await expect(app.call('mcp.mockTools.echoText', { text: 'x' })).rejects.toMatchObject({ code: 'not_found' })
  })
})
