import { sign } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { webhookKey } from '@mushinjs/plugin-adapter-qq'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { startMockQQ } from './helpers/mock-qq'

let app: TestInstance
let qq: Awaited<ReturnType<typeof startMockQQ>>
const SECRET = 'secret-secret'

beforeAll(async () => {
  qq = await startMockQQ()
  app = await startInstance()
})

afterAll(async () => {
  await app?.stop()
  await qq?.close()
})

const config = (extra: Record<string, any>) => ({ appId: 'app1', secret: SECRET, endpoint: qq.url, tokenEndpoint: `${qq.url}/app/getAppAccessToken`, ...extra })

describe('QQ official adapter over WebSocket', () => {
  let botId: string

  it('lists the adapter with its hidden fields', async () => {
    const adapters = await app.call<any[]>('bots.adapters')
    expect(adapters.find((item) => item.id === 'qq')).toMatchObject({ secrets: ['secret'], hiddenFields: { '*': ['endpoint', 'tokenEndpoint'] }, qrSetup: { start: 'qq.bindStart', poll: 'qq.bindPoll' } })
    expect(adapters.find((item) => item.id === 'telegram').links[0].url).toBe('https://t.me/BotFather')
  })

  it('identifies at the gateway and goes online', async () => {
    const bot = await app.call('bots.create', { name: 'QQ', adapter: { type: 'qq', config: config({}) }, plugins: [{ package: '@mushinjs/bot-plugin-echo' }] })
    botId = bot.id
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
    const info = await app.call('bots.get', { id: botId })
    expect(info).toMatchObject({ selfId: '9001', selfName: 'Mock QQ Bot', connection: { mode: 'ws' } })
    expect(info.adapter.config.secret).not.toBe(SECRET)
    expect(qq.identifies[0]).toMatchObject({ token: 'QQBot tok1', shard: [0, 1] })
    expect(qq.identifies[0].intents & (1 << 25)).toBeTruthy()
    expect(qq.calls.find((call) => call.path === '/gateway')?.auth).toBe('QQBot tok1')
  })

  it('answers a group @-message passively', async () => {
    qq.dispatch('GROUP_AT_MESSAGE_CREATE', { id: 'msg-1', author: { member_openid: 'MEMBER1' }, content: ' echo hello', group_openid: 'GROUPA', timestamp: '2024-01-01T00:00:00+08:00' })
    const sent = await waitFor(() => qq.calls.find((call) => call.path === '/v2/groups/GROUPA/messages'))
    expect(sent.body).toMatchObject({ msg_type: 0, content: 'hello', msg_id: 'msg-1', msg_seq: 1 })
    const records = await app.call<any[]>('bots.messages', { id: botId })
    expect(records.find((record) => record.direction === 'in')).toMatchObject({ channel: { type: 'group', id: 'GROUPA' }, user: { id: 'MEMBER1' } })
  })

  it('uploads pictures to C2C chats before sending them', async () => {
    qq.dispatch('C2C_MESSAGE_CREATE', { id: 'msg-2', author: { user_openid: 'USERB' }, content: 'hi' })
    await waitFor(async () => (await app.call<any[]>('bots.messages', { id: botId })).some((record) => record.messageId === 'msg-2'))
    await app.ctx.get('bots')!.bot(botId)!.deliver({ type: 'private', id: 'USERB' }, [{ type: 'text', data: { text: 'a cat' } }, { type: 'image', data: { file: 'https://example.com/cat.png' } }], {})
    const upload = await waitFor(() => qq.calls.find((call) => call.path === '/v2/users/USERB/files'))
    expect(upload.body).toMatchObject({ file_type: 1, url: 'https://example.com/cat.png', srv_send_msg: false })
    const message = await waitFor(() => qq.calls.find((call) => call.path === '/v2/users/USERB/messages'))
    expect(message.body).toMatchObject({ msg_type: 7, media: { file_info: 'info-1' }, content: 'a cat', msg_id: 'msg-2' })
  })

  it('sends to guild channels with mentions', async () => {
    qq.dispatch('AT_MESSAGE_CREATE', { id: 'g-1', channel_id: '700', guild_id: '800', author: { id: '42', username: 'Ann' }, content: '<@!9001> echo yo', mentions: [{ id: '9001', username: 'Mock QQ Bot' }] })
    const sent = await waitFor(() => qq.calls.find((call) => call.path === '/channels/700/messages'))
    expect(sent.body).toMatchObject({ content: 'yo', msg_id: 'g-1' })
  })
})

describe('QQ official adapter over webhook', () => {
  let botId: string
  const key = webhookKey(SECRET)

  const post = (payload: unknown, signed = true) => {
    const body = JSON.stringify(payload)
    const timestamp = '1700000000'
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-signature-timestamp': timestamp }
    if (signed) headers['x-signature-ed25519'] = sign(null, Buffer.from(timestamp + body), key).toString('hex')
    return fetch(`${app.base}/qq/${botId}`, { method: 'POST', headers, body })
  }

  it('goes online once QQ gives a token', async () => {
    const bot = await app.call('bots.create', { name: 'QQ hook', adapter: { type: 'qq', config: config({ mode: 'webhook' }) }, plugins: [{ package: '@mushinjs/bot-plugin-echo' }] })
    botId = bot.id
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
    expect((await app.call('bots.get', { id: botId })).connection).toEqual({ mode: 'webhook', inbound: `/qq/${botId}` })
  })

  it('answers the callback address check', async () => {
    const response = await post({ op: 13, d: { plain_token: 'plain', event_ts: '123' } }, false)
    const body = await response.json() as any
    expect(body.plain_token).toBe('plain')
    expect(body.signature).toBe(sign(null, Buffer.from('123plain'), key).toString('hex'))
  })

  it('takes signed events and refuses unsigned ones', async () => {
    const unsigned = await post({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'h-0', author: { member_openid: 'M' }, content: 'echo nope', group_openid: 'GROUPH' } }, false)
    expect(unsigned.status).toBe(401)
    const response = await post({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', id: 'e1', d: { id: 'h-1', author: { member_openid: 'M' }, content: 'echo via hook', group_openid: 'GROUPH' } })
    expect(await response.json()).toEqual({ op: 12, d: 0 })
    const sent = await waitFor(() => qq.calls.find((call) => call.path === '/v2/groups/GROUPH/messages'))
    expect(sent.body).toMatchObject({ content: 'via hook', msg_id: 'h-1' })
    expect(qq.calls.filter((call) => call.path === '/v2/groups/GROUPH/messages')).toHaveLength(1)
  })
})
