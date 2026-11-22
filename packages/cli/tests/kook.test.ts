import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type WebSocket, WebSocketServer } from 'ws'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

const TOKEN = 'kook-token'
let app: TestInstance
let server: Server
let wss: WebSocketServer
let endpoint: string
const calls: { method: string; path: string; body: any; type?: string; auth?: string }[] = []
const connections: string[] = []
let client: WebSocket | undefined
let sn = 0

const push = (d: unknown) => client?.send(JSON.stringify({ s: 0, d, sn: ++sn }))

/** The KOOK API and WebSocket gateway, enough for the adapter. */
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      const type = req.headers['content-type']
      const path = (req.url ?? '').split('?')[0]
      calls.push({ method: req.method!, path, body: type?.startsWith('application/json') ? JSON.parse(body) : body, type, auth: req.headers.authorization })
      const ok = (data: unknown) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ code: 0, message: 'ok', data }))
      }
      if (req.headers.authorization !== `Bot ${TOKEN}`) {
        res.statusCode = 401
        return res.end(JSON.stringify({ code: 401, message: 'unauthorized' }))
      }
      if (path === '/user/me') return ok({ id: 'bot1', username: 'MushinBot', nickname: 'Mushin', avatar: 'https://img.kookapp.cn/avatar.png' })
      if (path === '/gateway/index') return ok({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/gateway?compress=0&token=x` })
      if (path === '/asset/create') return ok({ url: 'https://img.kookapp.cn/assets/up.png' })
      if (path === '/guild/view') return ok({ id: 'g1', master_id: 'owner1' })
      if (path === '/guild-role/list') return ok({ items: [{ role_id: 7, permissions: 1 }] })
      if (path === '/user/view') return ok({ id: 'u2', roles: [7] })
      if (path.endsWith('/create')) return ok({ msg_id: `sent-${calls.length}`, msg_timestamp: 1 })
      ok({})
    })
  })
  wss = new WebSocketServer({ server, path: '/gateway' })
  wss.on('connection', (socket, req) => {
    client = socket
    connections.push(req.url ?? '')
    const resume = new URL(req.url ?? '', 'http://x').searchParams.get('resume')
    socket.send(JSON.stringify(resume ? { s: 6, d: { session_id: 'sess' } } : { s: 1, d: { code: 0, session_id: 'sess' } }))
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString())
      if (frame.s === 2) socket.send(JSON.stringify({ s: 3 }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  app = await startInstance()
})

afterAll(async () => {
  await app?.stop()
  for (const socket of wss?.clients ?? []) socket.terminate()
  wss?.close()
  await new Promise((resolve) => server?.close(resolve))
})

describe('KOOK adapter over WebSocket', () => {
  let botId: string

  it('logs in and receives the hello', async () => {
    const bot = await app.call('bots.create', { name: 'KOOK', adapter: { type: 'kook', config: { token: TOKEN, endpoint } }, plugins: [{ package: '@mushinjs/bot-plugin-echo' }] })
    botId = bot.id
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
    expect(await app.call('bots.get', { id: botId })).toMatchObject({ selfId: 'bot1', selfName: 'Mushin', connection: { mode: 'ws' } })
  })

  it('answers a channel message and skips repeated events', async () => {
    const event = { channel_type: 'GROUP', type: 1, target_id: 'c1', author_id: 'u1', content: 'echo hello', msg_id: 'm1', msg_timestamp: 1, extra: { type: 1, guild_id: 'g1', channel_name: 'chat', author: { id: 'u1', username: 'ann' } } }
    push(event)
    client?.send(JSON.stringify({ s: 0, d: event, sn }))
    const sent = await waitFor(() => calls.find((call) => call.path === '/message/create'))
    expect(sent.body).toEqual({ type: 1, target_id: 'c1', content: 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(calls.filter((call) => call.path === '/message/create')).toHaveLength(1)
  })

  it('uploads pictures and sends direct messages with mentions', async () => {
    const bot = app.ctx.get('bots')!.bot(botId)!
    await bot.deliver({ type: 'private', id: 'u1' }, [{ type: 'reply', data: { id: 'm1' } }, { type: 'at', data: { qq: 'u1' } }, { type: 'text', data: { text: ' look (here)' } }, { type: 'image', data: { file: `base64://${Buffer.from('png').toString('base64')}` } }], {})
    const direct = calls.filter((call) => call.path === '/direct-message/create')
    expect(direct[0].body).toEqual({ type: 9, target_id: 'u1', content: '(met)u1(met) look \\(here\\)', quote: 'm1' })
    expect(calls.find((call) => call.path === '/asset/create')?.type).toMatch(/^multipart/)
    expect(direct[1].body).toEqual({ type: 2, target_id: 'u1', content: 'https://img.kookapp.cn/assets/up.png' })
  })

  it('reads server roles', async () => {
    const bot = app.ctx.get('bots')!.bot(botId)!
    expect(await bot.groupRoleOf({ channel: { type: 'group', id: 'c1' }, user: { id: 'owner1' } })).toBe('owner')
    expect(await bot.groupRoleOf({ channel: { type: 'group', id: 'c1' }, user: { id: 'u2' } })).toBe('admin')
  })

  it('resumes from the last event after a drop', async () => {
    client?.terminate()
    await waitFor(() => connections.some((url) => url.includes('resume=1')))
    const resumed = new URL(connections.find((url) => url.includes('resume=1'))!, 'http://x').searchParams
    expect(resumed.get('session_id')).toBe('sess')
    expect(resumed.get('sn')).toBe(String(sn))
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
  })
})

describe('KOOK adapter over webhook', () => {
  let botId: string

  it('answers the challenge and takes events with the verify token', async () => {
    const bot = await app.call('bots.create', { name: 'KOOK hook', adapter: { type: 'kook', config: { token: TOKEN, endpoint, mode: 'webhook', verifyToken: 'vt' } }, plugins: [{ package: '@mushinjs/bot-plugin-echo' }] })
    botId = bot.id
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
    const post = (d: unknown, n = 1) => fetch(`${app.base}/kook/${botId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ s: 0, d, sn: n }) })
    const challenge = await post({ type: 255, channel_type: 'WEBHOOK_CHALLENGE', challenge: 'abc', verify_token: 'vt' })
    expect(await challenge.json()).toEqual({ challenge: 'abc' })
    expect((await post({ type: 1, verify_token: 'wrong' })).status).toBe(401)
    const event = { channel_type: 'GROUP', type: 1, target_id: 'c9', author_id: 'u1', content: 'echo hooked', msg_id: 'h1', verify_token: 'vt', extra: { guild_id: 'g1', author: { username: 'ann' } } }
    expect((await post(event, 2)).status).toBe(200)
    const sent = await waitFor(() => calls.find((call) => call.path === '/message/create' && call.body.target_id === 'c9'))
    expect(sent.body.content).toBe('hooked')
  })
})
