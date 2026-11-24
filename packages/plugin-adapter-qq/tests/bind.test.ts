import { createCipheriv, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decryptSecret, QQBinder } from '../src/bind'

function encrypt(text: string, key: Buffer) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64')
}

/** The QQ Open Platform's binding endpoints: a task waits for two polls, then reports the new bot. */
let server: Server
let host: string
const keys = new Map<string, Buffer>()
const polls = new Map<string, number>()

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const params = JSON.parse(body)
      res.setHeader('content-type', 'application/json')
      if (req.url === '/lite/create_bind_task') {
        const id = `task-${keys.size + 1}`
        keys.set(id, Buffer.from(params.key, 'base64'))
        return res.end(JSON.stringify({ retcode: 0, data: { task_id: id } }))
      }
      if (req.url === '/lite/poll_bind_result') {
        const count = (polls.get(params.task_id) ?? 0) + 1
        polls.set(params.task_id, count)
        if (params.task_id === 'task-2') return res.end(JSON.stringify({ retcode: 0, data: { status: 3 } }))
        if (count < 3) return res.end(JSON.stringify({ retcode: 0, data: { status: 1 } }))
        return res.end(JSON.stringify({ retcode: 0, data: { status: 2, bot_appid: '102000001', bot_encrypt_secret: encrypt('the-secret', keys.get(params.task_id)!) } }))
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise((resolve) => server.close(resolve)))

describe('QQ scan-to-create', () => {
  it('shows the task page as a QR code and returns the new bot once confirmed', async () => {
    const binder = new QQBinder(host)
    const task = await binder.start()
    expect(task).toEqual({ id: 'task-1', qrcode: `${host}/qqbot/openclaw/connect.html?task_id=task-1&_wv=2`, interval: 2 })
    expect(keys.get('task-1')).toHaveLength(32)
    expect(await binder.poll(task.id)).toEqual({ status: 'pending' })
    expect(await binder.poll(task.id)).toEqual({ status: 'pending' })
    expect(await binder.poll(task.id)).toEqual({ status: 'created', config: { appId: '102000001', secret: 'the-secret' } })
    // A finished binding is forgotten.
    expect(await binder.poll(task.id)).toEqual({ status: 'expired' })
  })

  it('reports expired codes and unknown tasks', async () => {
    const binder = new QQBinder(host)
    const task = await binder.start()
    expect(await binder.poll(task.id)).toEqual({ status: 'expired' })
    expect(await binder.poll('nope')).toEqual({ status: 'expired' })
  })

  it('refuses a secret encrypted under another key', () => {
    expect(() => decryptSecret(encrypt('x', randomBytes(32)), randomBytes(32))).toThrow()
  })
})
