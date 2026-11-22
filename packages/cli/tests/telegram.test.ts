import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { webhookSecret } from '@mushinjs/plugin-adapter-telegram'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

const TOKEN = '123:secret-token'
let app: TestInstance
let telegram: Server
let endpoint: string
const calls: { method: string; params: any; type?: string }[] = []
/** Updates handed out by the next getUpdates. */
const queue: any[] = []
const pollers: (() => void)[] = []
let updateId = 100

/** A Bot API server: answers methods at /bot<token>/<method>, holding getUpdates until updates arrive. */
beforeAll(async () => {
  telegram = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '')
      const reply = (value: unknown) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(value))
      }
      if (!match || match[1] !== TOKEN) return reply({ ok: false, error_code: 401, description: 'Unauthorized' })
      const method = match[2]
      const type = req.headers['content-type']
      const body = Buffer.concat(chunks).toString()
      const params = type?.startsWith('application/json') && body ? JSON.parse(body) : { raw: body }
      if (method !== 'getUpdates') calls.push({ method, params, type })
      if (method === 'getMe') return reply({ ok: true, result: { id: 777, is_bot: true, first_name: 'Mushin', username: 'MushinBot' } })
      if (method === 'getChatMember') return reply({ ok: true, result: { status: 'administrator', user: { id: params.user_id } } })
      if (method === 'getUpdates') {
        const answer = () => {
          const updates = queue.splice(0).filter((update) => params.offset === undefined || update.update_id >= params.offset)
          reply({ ok: true, result: updates })
        }
        if (queue.length) return answer()
        const timer = setTimeout(answer, 500)
        pollers.push(() => (clearTimeout(timer), answer()))
        return
      }
      if (method.startsWith('send')) return reply({ ok: true, result: { message_id: 500 + calls.length, chat: { id: params.chat_id } } })
      reply({ ok: true, result: true })
    })
  })
  await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(telegram.address() as AddressInfo).port}`
  app = await startInstance()
})

afterAll(async () => {
  await app?.stop()
  await new Promise((resolve) => telegram?.close(resolve))
})

function push(message: Record<string, any>) {
  queue.push({ update_id: ++updateId, message: { message_id: updateId, date: 1_700_000_000, ...message } })
  for (const poll of pollers.splice(0)) poll()
}

describe('Telegram adapter with long polling', () => {
  let botId: string

  it('logs in and starts polling', async () => {
    const bot = await app.call('bots.create', { name: 'TG', adapter: { type: 'telegram', config: { token: TOKEN, endpoint } }, plugins: [{ package: '@mushinjs/bot-plugin-echo' }] })
    botId = bot.id
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
    const info = await app.call('bots.get', { id: botId })
    expect(info).toMatchObject({ selfId: '777', selfName: 'Mushin', connection: { mode: 'polling' } })
    expect(info.adapter.config.token).not.toBe(TOKEN)
    expect(calls.some((call) => call.method === 'deleteWebhook')).toBe(true)
  })

  it('answers a group message, keeping the bot command clean', async () => {
    push({ chat: { id: -1001, type: 'supergroup', title: 'Fans' }, from: { id: 42, first_name: 'Ann' }, text: 'echo hello there' })
    const sent = await waitFor(() => calls.find((call) => call.method === 'sendMessage'))
    expect(sent.params).toMatchObject({ chat_id: '-1001', text: 'hello there' })
    const incoming = (await app.call<any[]>('bots.messages', { id: botId })).find((record) => record.direction === 'in')
    expect(incoming).toMatchObject({ channel: { type: 'group', id: '-1001', name: 'Fans' }, user: { id: '42', name: 'Ann' } })
  })

  it('replies in forum topics and with quotes', async () => {
    push({ chat: { id: -1002, type: 'supergroup', is_forum: true }, from: { id: 42, first_name: 'Ann' }, text: 'echo topic', is_topic_message: true, message_thread_id: 9 })
    const sent = await waitFor(() => calls.find((call) => call.method === 'sendMessage' && call.params.chat_id === '-1002'))
    expect(sent.params.message_thread_id).toBe(9)
    const bot = app.ctx.get('bots')!.bot(botId)!
    await bot.deliver({ type: 'group', id: '-1001' }, [{ type: 'reply', data: { id: '101' } }, { type: 'image', data: { file: 'https://example.com/cat.png' } }, { type: 'text', data: { text: 'a cat' } }], {})
    const photo = await waitFor(() => calls.find((call) => call.method === 'sendPhoto'))
    expect(photo.params).toMatchObject({ chat_id: '-1001', photo: 'https://example.com/cat.png', caption: 'a cat', reply_parameters: { message_id: 101 } })
  })

  it('uploads local media as multipart', async () => {
    const bot = app.ctx.get('bots')!.bot(botId)!
    await bot.deliver({ type: 'private', id: '42' }, [{ type: 'file', data: { file: `base64://${Buffer.from('hello').toString('base64')}`, name: 'hello.txt' } }], {})
    const document = await waitFor(() => calls.find((call) => call.method === 'sendDocument'))
    expect(document.type).toMatch(/^multipart\/form-data/)
    expect(document.params.raw).toContain('hello.txt')
    expect(document.params.raw).toContain('name="chat_id"')
  })

  it('reads group roles from getChatMember', async () => {
    const bot = app.ctx.get('bots')!.bot(botId)!
    expect(await bot.groupRoleOf({ channel: { type: 'group', id: '-1001' }, user: { id: '42' } })).toBe('admin')
  })
})

describe('Telegram adapter with a webhook', () => {
  let botId: string

  it('registers the webhook with a secret token', async () => {
    const bot = await app.call('bots.create', { name: 'TG hook', adapter: { type: 'telegram', config: { token: TOKEN, endpoint, mode: 'webhook', publicUrl: 'https://bot.example.com' } }, plugins: [{ package: '@mushinjs/bot-plugin-echo' }] })
    botId = bot.id
    await waitFor(async () => (await app.call('bots.get', { id: botId })).status === 'online')
    const registered = calls.find((call) => call.method === 'setWebhook')!
    expect(registered.params).toMatchObject({ url: `https://bot.example.com/telegram/${botId}`, secret_token: webhookSecret(TOKEN) })
  })

  it('takes updates with the secret token only', async () => {
    const update = { update_id: 1, message: { message_id: 1, date: 1, chat: { id: 55, type: 'private', first_name: 'Cy' }, from: { id: 55, first_name: 'Cy' }, text: 'echo hooked' } }
    const refused = await fetch(`${app.base}/telegram/${botId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) })
    expect(refused.status).toBe(401)
    const accepted = await fetch(`${app.base}/telegram/${botId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': webhookSecret(TOKEN) },
      body: JSON.stringify(update),
    })
    expect(accepted.status).toBe(200)
    const sent = await waitFor(() => calls.find((call) => call.method === 'sendMessage' && call.params.chat_id === '55'))
    expect(sent.params.text).toBe('hooked')
  })
})
