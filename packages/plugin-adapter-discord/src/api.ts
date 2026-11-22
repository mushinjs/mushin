export const API_ENDPOINT = 'https://discord.com/api/v10'

const REQUEST_TIMEOUT = 30_000
/** The longest rate-limit wait Mushin sits out before giving up on a request. */
const MAX_RETRY_AFTER = 30

export class DiscordError extends Error {
  name = 'DiscordError'
  constructor(message: string, public status: number, public body?: any) {
    super(message)
  }
}

/** The Discord REST API with a bot token; a rate-limited request waits as long as Discord asks, once. */
export class DiscordApi {
  constructor(private token: string, private endpointUrl = '') {}

  get endpoint() {
    return (this.endpointUrl || API_ENDPOINT).replace(/\/+$/, '')
  }

  async request<T = any>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    if (!this.token) throw new DiscordError('no bot token set', 401)
    const headers: Record<string, string> = {
      authorization: `Bot ${this.token}`,
      'user-agent': 'DiscordBot (https://github.com/mushinjs/mushin, 1)',
    }
    let payload: FormData | string | undefined
    if (body instanceof FormData) payload = body
    else if (body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const response = await fetch(`${this.endpoint}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
    const text = await response.text()
    let data: any
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      data = text
    }
    if (response.status === 429 && !retried) {
      const wait = Number(data?.retry_after ?? response.headers.get('retry-after') ?? 1)
      if (wait <= MAX_RETRY_AFTER) {
        await new Promise((resolve) => setTimeout(resolve, wait * 1000))
        return this.request(method, path, body, true)
      }
    }
    if (!response.ok) {
      const reason = data?.message ? `${data.message}${data.code ? ` (code ${data.code})` : ''}` : `HTTP ${response.status}`
      throw new DiscordError(`${method} ${path} failed: ${reason}`, response.status, data)
    }
    return data as T
  }
}
