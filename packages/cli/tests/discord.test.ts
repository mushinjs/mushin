import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type WebSocket, WebSocketServer } from 'ws'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

const TOKEN = 'discord-token'
let app: TestInstance
let server: Server
let wss: WebSocketServer
let endpoint: string
const calls: { method: string; path: string; body: any; type?: string; auth?: string }[] = []
const frames: any[] = []
let client: WebSocket | undefined
let seq = 0

const dispatch = (t: string, d: unknown) => client?.send(JSON.stringify({ op: 0, s: ++seq, t, d }))

/** A Discord REST API and gateway, enough for the adapter. */
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      const type = req.headers['content-type']
      calls.push({ method: req.method!, path: req.url!, body: type?.startsWith('application/json') ? JSON.parse(body) : body, type, auth: req.headers.authorization })
      const json = (value: unknown) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(value))
      }
      if (req.url === '/gateway/bot') return json({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`, shards: 1 })
      if (req.url === '/users/@me/channels') return json({ id: 'dm-77', type: 1 })
      if (req.url?.startsWith('/guilds/g1/members/')) return json({ roles: ['r-admin'] })
      if (req.url?.endsWith('/messages')) return json({ id: `sent-${calls.length}` })
      res.statusCode = 404
      json({ message: 'Unknown', code: 0 })
    })
  })
  wss = new WebSocketServer({ server, path: '/gateway' })
  wss.on('connection', (socket) => {
    client = socket
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }))
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString())
      frames.push(frame)
      if (frame.op === 1) socket.send(JSON.stringify({ op: 11 }))
      if (frame.op === 2) {
        dispatch('READY', { v: 10, session_id: 'sess', resume_gateway_url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`, user: { id: '900', username: 'mushin', global_name: 'Mushin', avatar: 'abc' }, guilds: [{ id: 'g1', unavailable: true }] })
        dispatch('GUILD_CREATE', { id: 'g1', name: 'Club', owner_id: '1', roles: [{ id: 'r-admin', permissions: '8' }], channels: [{ id: 'c1', name: 'general', type: 0 }, { id: 'v1', name: 'Voice', type: 2 }] })
      }
      if (frame.op === 6) dispatch('RESUMED', {})
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

describe('Discord adapter', () => {
  let botId: string

  it('identifies at the gateway and goes online', async () => {
    const bot = await app.call('bots.create', { name: 'DC', adapter: { type: 'discord', config: { token: TOKEN, endpoint } }, plugins: [{ package: '@mushinjs/bot-plugin-echo' }] })
    botId = bot.id
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
    expect(await app.call('bots.get', { id: botId })).toMatchObject({ selfId: '900', selfName: 'Mushin', selfAvatar: 'https://cdn.discordapp.com/avatars/900/abc.png' })
    const identify = frames.find((frame) => frame.op === 2)
    expect(identify.d).toMatchObject({ token: TOKEN })
    expect(identify.d.intents & (1 << 15)).toBeTruthy()
    expect(calls.find((call) => call.path === '/gateway/bot')?.auth).toBe(`Bot ${TOKEN}`)
  })

  it('answers in guild channels and names the channel', async () => {
    dispatch('MESSAGE_CREATE', { id: 'm1', type: 0, channel_id: 'c1', guild_id: 'g1', author: { id: '5', username: 'ann' }, member: { roles: [] }, content: 'echo hi <@900>', mentions: [{ id: '900', username: 'mushin' }], timestamp: '2024-01-01T00:00:00Z' })
    const sent = await waitFor(() => calls.find((call) => call.path === '/channels/c1/messages'))
    expect(sent.body).toMatchObject({ content: 'hi' })
    const incoming = (await app.call<any[]>('bots.messages', { id: botId })).find((record) => record.direction === 'in')
    expect(incoming).toMatchObject({ channel: { type: 'group', id: 'c1', name: 'general' }, user: { id: '5', name: 'ann', role: 'member' } })
  })

  it('opens a DM channel to message a person', async () => {
    const bot = app.ctx.get('bots')!.bot(botId)!
    await bot.deliver({ type: 'private', id: '77' }, [{ type: 'reply', data: { id: 'm9' } }, { type: 'text', data: { text: 'hello ' } }, { type: 'at', data: { qq: '77' } }, { type: 'image', data: { file: 'https://example.com/a.png' } }], {})
    expect(calls.find((call) => call.path === '/users/@me/channels')?.body).toEqual({ recipient_id: '77' })
    const sent = await waitFor(() => calls.find((call) => call.path === '/channels/dm-77/messages'))
    expect(sent.body).toMatchObject({ content: 'hello <@77>', message_reference: { message_id: 'm9' }, embeds: [{ image: { url: 'https://example.com/a.png' } }] })
  })

  it('uploads local files as attachments', async () => {
    const bot = app.ctx.get('bots')!.bot(botId)!
    await bot.deliver({ type: 'group', id: 'c1' }, [{ type: 'text', data: { text: 'notes' } }, { type: 'file', data: { file: `base64://${Buffer.from('hi').toString('base64')}`, name: 'notes.txt' } }], {})
    const sent = await waitFor(() => calls.find((call) => call.path === '/channels/c1/messages' && call.type?.startsWith('multipart')))
    expect(sent.body).toContain('name="payload_json"')
    expect(sent.body).toContain('notes.txt')
  })

  it('lists text channels as contacts and reads roles', async () => {
    const bot = app.ctx.get('bots')!.bot(botId)!
    expect(await bot.contacts()).toEqual([{ type: 'group', id: 'c1', name: '#general (Club)' }])
    expect(await bot.groupRoleOf({ channel: { type: 'group', id: 'c1' }, user: { id: '1' } })).toBe('owner')
    expect(await bot.groupRoleOf({ channel: { type: 'group', id: 'c1' }, user: { id: '2' } })).toBe('admin')
  })

  it('resumes the session after a drop', async () => {
    client?.close(4000, 'test drop')
    await waitFor(() => frames.find((frame) => frame.op === 6))
    expect(frames.find((frame) => frame.op === 6).d).toMatchObject({ token: TOKEN, session_id: 'sess' })
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
  })
})
