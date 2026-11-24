import { createDecipheriv, randomBytes } from 'node:crypto'

/** The QQ Open Platform host that runs scan-to-create binding. */
export const BIND_HOST = 'q.qq.com'

const REQUEST_TIMEOUT = 10_000
/** How long a started binding is kept waiting for its scan. */
const TASK_TTL = 10 * 60_000
const POLL_INTERVAL = 2

/** Status numbers of `poll_bind_result`. */
const STATUS = { pending: 1, created: 2, expired: 3 } as const

export type BindResult =
  | { status: 'pending' }
  | { status: 'created'; config: { appId: string; secret: string } }
  | { status: 'expired' }
  | { status: 'error'; message: string }

/**
 * Decrypts the AppSecret QQ returns after a scan: base64 of a 12-byte nonce, the AES-256-GCM
 * ciphertext and its 16-byte tag, under the key Mushin sent when it started the binding.
 */
export function decryptSecret(encrypted: string, key: Buffer) {
  const bytes = Buffer.from(encrypted, 'base64')
  if (bytes.length < 12 + 16 + 1) throw new Error('the encrypted AppSecret is too short')
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(bytes.length - 16))
  return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString('utf8')
}

/**
 * Creates a QQ bot by scanning a QR code with mobile QQ, as the QQ Open Platform's "lite" binding
 * works: Mushin sends a fresh AES key with `create_bind_task`, shows the returned task's page as a
 * QR code, and polls `poll_bind_result` until the person has confirmed; QQ then answers with the
 * new bot's AppID and its AppSecret encrypted under that key. Nothing needs signing in first.
 */
export class QQBinder {
  private tasks = new Map<string, { key: Buffer; at: number }>()

  constructor(private host = BIND_HOST) {}

  private base() {
    const host = this.host.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    return { api: `${/^http:\/\//.test(this.host) ? 'http' : 'https'}://${host}`, host }
  }

  private async post(path: string, body: unknown) {
    const response = await fetch(`${this.base().api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
    const result = await response.json().catch(() => undefined) as any
    if (!response.ok) throw new Error(`QQ answered HTTP ${response.status}`)
    if (result?.retcode !== undefined && result.retcode !== 0) throw new Error(result.msg || result.message || `QQ answered retcode ${result.retcode}`)
    return result?.data ?? {}
  }

  /** Starts a binding; the QR code opens QQ's confirmation page for it. */
  async start() {
    for (const [id, task] of this.tasks) if (Date.now() - task.at > TASK_TTL) this.tasks.delete(id)
    const key = randomBytes(32)
    const data = await this.post('/lite/create_bind_task', { key: key.toString('base64') })
    const id = data.task_id ? String(data.task_id) : ''
    if (!id) throw new Error('QQ returned no binding task')
    this.tasks.set(id, { key, at: Date.now() })
    const qrcode = `${this.base().api}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(id)}&_wv=2`
    return { id, qrcode, interval: POLL_INTERVAL }
  }

  /** Whether the person has scanned and confirmed; once created, the binding is forgotten. */
  async poll(id: string): Promise<BindResult> {
    const task = this.tasks.get(id)
    if (!task || Date.now() - task.at > TASK_TTL) {
      this.tasks.delete(id)
      return { status: 'expired' }
    }
    const data = await this.post('/lite/poll_bind_result', { task_id: id })
    const status = Number(data.status)
    if (status === STATUS.expired) {
      this.tasks.delete(id)
      return { status: 'expired' }
    }
    if (status !== STATUS.created) return { status: 'pending' }
    this.tasks.delete(id)
    if (!data.bot_appid || !data.bot_encrypt_secret) return { status: 'error', message: 'QQ confirmed the scan but returned no AppID or AppSecret' }
    try {
      return { status: 'created', config: { appId: String(data.bot_appid), secret: decryptSecret(String(data.bot_encrypt_secret), task.key) } }
    } catch (error) {
      return { status: 'error', message: `cannot decrypt the AppSecret: ${(error as Error).message}` }
    }
  }
}
