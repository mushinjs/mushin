export const API_ENDPOINT = 'https://api.telegram.org'

const REQUEST_TIMEOUT = 30_000

export class TelegramError extends Error {
  name = 'TelegramError'
  constructor(public method: string, public code: number, public description: string, public retryAfter?: number) {
    super(`Telegram ${method} failed (${code}): ${description}`)
  }
}

/**
 * The Telegram Bot API: `POST <endpoint>/bot<token>/<method>`, JSON or multipart bodies, and
 * `{ ok, result }` answers. The token is part of every address, so addresses are never logged.
 */
export class TelegramApi {
  constructor(private token: string, private endpointUrl = '') {}

  get endpoint() {
    return (this.endpointUrl || API_ENDPOINT).replace(/\/+$/, '')
  }

  async call<T = any>(method: string, params: Record<string, any> | FormData = {}, options: { timeout?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (!this.token) throw new TelegramError(method, 401, 'no bot token set')
    const timeout = AbortSignal.timeout(options.timeout ?? REQUEST_TIMEOUT)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const form = params instanceof FormData
    const response = await fetch(`${this.endpoint}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: form ? {} : { 'content-type': 'application/json' },
      body: form ? params : JSON.stringify(params),
      signal,
    })
    const body = await response.json().catch(() => undefined) as any
    if (!body?.ok) {
      const code = Number(body?.error_code ?? response.status)
      throw new TelegramError(method, code, String(body?.description ?? `HTTP ${response.status}`), body?.parameters?.retry_after)
    }
    return body.result as T
  }

  /** Calls a method, waiting once as long as Telegram asks when it is rate limited. */
  async callRetrying<T = any>(method: string, params: Record<string, any> | FormData = {}): Promise<T> {
    try {
      return await this.call<T>(method, params)
    } catch (error) {
      if (!(error instanceof TelegramError) || error.code !== 429 || !error.retryAfter || error.retryAfter > 30) throw error
      await new Promise((resolve) => setTimeout(resolve, error.retryAfter! * 1000))
      return this.call<T>(method, params)
    }
  }

  /** Downloads a file from `getFile`; its address holds the token, so only the bytes leave here. */
  async download(fileId: string) {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId })
    if (!file.file_path) throw new Error('Telegram returned no file path (files over 20 MB cannot be downloaded by bots)')
    const response = await fetch(`${this.endpoint}/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
    if (!response.ok) throw new Error(`downloading the file failed: HTTP ${response.status}`)
    return { bytes: Buffer.from(await response.arrayBuffer()), path: file.file_path, type: response.headers.get('content-type') }
  }
}
