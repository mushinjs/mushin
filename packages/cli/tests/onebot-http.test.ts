import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance
let napcat: Server
let napcatUrl: string
let botId: string
const calls: { action: string; params: any; auth?: string }[] = []

const SECRET = 'report-secret'

/** A NapCat HTTP server: answers OneBot API calls as POST /<action>. */
beforeAll(async () => {
  napcat = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const action = (req.url ?? '/').slice(1)
      calls.push({ action, params: body ? JSON.parse(body) : {}, auth: req.headers.authorization })
      const data = action === 'get_login_info' ? { user_id: 10001, nickname: 'HTTP Bot' } : action === 'send_group_msg' ? { message_id: calls.length } : null
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }))
    })
  })
  await new Promise<void>((resolve) => napcat.listen(0, '127.0.0.1', resolve))
  napcatUrl = `http://127.0.0.1:${(napcat.address() as AddressInfo).port}`
  app = await startInstance()
})

afterAll(async () => {
  await app?.stop()
  await new Promise((resolve) => napcat?.close(resolve))
})

/** NapCat's HTTP client posting an event, signed like NapCat signs it. */
function post(event: unknown, secret = SECRET) {
  const body = JSON.stringify(event)
  const signature = createHmac('sha1', secret).update(body).digest('hex')
  return fetch(`${app.base}/onebot/${botId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': `sha1=${signature}` }, body })
}

describe('OneBot HTTP mode', () => {
  it('logs in over HTTP and describes the connection', async () => {
    const bot = await app.call('bots.create', {
      name: 'Http',
      adapter: { type: 'onebot', config: { mode: 'http', url: napcatUrl, token: 'tok', secret: SECRET } },
      plugins: [{ package: '@mushin/bot-plugin-echo' }],
    })
    botId = bot.id
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
    const info = await app.call('bots.get', { id: botId })
    expect(info).toMatchObject({ selfId: '10001', connection: { mode: 'http', address: napcatUrl, inbound: `/onebot/${botId}` } })
    expect(info.adapter.config.secret).not.toBe(SECRET)
    expect(calls.find((call) => call.action === 'get_login_info')?.auth).toBe('Bearer tok')
  })

  it('receives signed events and answers through the HTTP API', async () => {
    const response = await post({ post_type: 'message', message_type: 'group', group_id: 500, user_id: 42, message_id: 7, message: [{ type: 'text', data: { text: 'echo hi there' } }], sender: { nickname: 'Ann' }, time: 1 })
    expect(response.status).toBe(204)
    const sent = await waitFor(() => calls.find((call) => call.action === 'send_group_msg'))
    expect(sent.params).toMatchObject({ group_id: 500 })
    expect(JSON.stringify(sent.params.message)).toContain('hi there')
  })

  it('refuses events with a wrong signature', async () => {
    const before = (await app.call<any[]>('bots.messages', { id: botId })).length
    const response = await post({ post_type: 'message', message_type: 'group', group_id: 500, user_id: 42, message: [{ type: 'text', data: { text: 'echo nope' } }] }, 'wrong')
    expect(response.status).toBe(401)
    expect((await app.call<any[]>('bots.messages', { id: botId })).length).toBe(before)
  })
})
