export const API_ENDPOINT = 'https://www.kookapp.cn/api/v3'

const REQUEST_TIMEOUT = 30_000

export class KookError extends Error {
  name = 'KookError'
  constructor(message: string, public code: number) {
    super(message)
  }
}

/** The KOOK API: `Authorization: Bot <token>`, answers `{ code, message, data }` with code 0 on success. */
export class KookApi {
  constructor(private token: string, private endpointUrl = '') {}

  get endpoint() {
    return (this.endpointUrl || API_ENDPOINT).replace(/\/+$/, '')
  }

  async request<T = any>(method: 'GET' | 'POST', path: string, params: Record<string, any> | FormData = {}): Promise<T> {
    if (!this.token) throw new KookError('no bot token set', 401)
    const headers: Record<string, string> = { authorization: `Bot ${this.token}` }
    let url = `${this.endpoint}${path}`
    let body: FormData | string | undefined
    if (method === 'GET') {
      const query = new URLSearchParams(Object.entries(params as Record<string, any>).map(([key, value]): [string, string] => [key, String(value)])).toString()
      if (query) url += `?${query}`
    } else if (params instanceof FormData) body = params
    else {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(params)
    }
    const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
    const result = await response.json().catch(() => undefined) as any
    if (response.status === 401) throw new KookError('KOOK refused the bot token', 401)
    if (!response.ok || !result || result.code !== 0) {
      throw new KookError(`${path} failed: ${result?.message || `HTTP ${response.status}`}${result?.code ? ` (code ${result.code})` : ''}`, result?.code ?? response.status)
    }
    return result.data as T
  }
}
