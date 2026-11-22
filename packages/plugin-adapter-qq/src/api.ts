export const API_ENDPOINT = 'https://api.sgroup.qq.com'
export const SANDBOX_ENDPOINT = 'https://sandbox.api.sgroup.qq.com'
export const TOKEN_ENDPOINT = 'https://bots.qq.com/app/getAppAccessToken'

const REQUEST_TIMEOUT = 30_000
/** Refresh the access token this long before QQ says it expires. */
const TOKEN_MARGIN = 60_000

export interface ApiOptions {
  appId: string
  secret: string
  sandbox?: boolean
  endpoint?: string
  tokenEndpoint?: string
}

export class QQApiError extends Error {
  name = 'QQApiError'
  constructor(message: string, public status: number, public body?: any) {
    super(message)
  }
}

/** What QQ said went wrong, without the trace id noise. */
function describeError(status: number, body: any) {
  if (body && typeof body === 'object') {
    const code = body.code ?? body.err_code
    const text = body.message ?? body.msg
    if (text) return `${text}${code !== undefined ? ` (code ${code})` : ''}`
  }
  return `HTTP ${status}`
}

/**
 * The QQ Bot OpenAPI: an app access token from AppID and AppSecret (refreshed before it expires),
 * sent as `Authorization: QQBot <token>` on every call.
 */
export class QQApi {
  private token?: { value: string; expires: number }
  private refreshing?: Promise<string>

  constructor(private options: ApiOptions) {}

  get endpoint() {
    return (this.options.endpoint || (this.options.sandbox ? SANDBOX_ENDPOINT : API_ENDPOINT)).replace(/\/+$/, '')
  }

  /** A current access token, fetching a new one when the last is about to expire. */
  accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expires - TOKEN_MARGIN) return Promise.resolve(this.token.value)
    this.refreshing ??= this.fetchToken().finally(() => (this.refreshing = undefined))
    return this.refreshing
  }

  /** Forgets the token, e.g. after QQ refused it. */
  invalidate() {
    this.token = undefined
  }

  private async fetchToken() {
    const { appId, secret } = this.options
    if (!appId || !secret) throw new QQApiError('the AppID and AppSecret are required', 0)
    const response = await fetch(this.options.tokenEndpoint || TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: secret }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
    const body = await response.json().catch(() => undefined) as any
    if (!response.ok || !body?.access_token) {
      throw new QQApiError(`getting an access token failed: ${describeError(response.status, body)}; check the AppID and AppSecret`, response.status, body)
    }
    const seconds = Number(body.expires_in)
    this.token = { value: String(body.access_token), expires: Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 7200) * 1000 }
    return this.token.value
  }

  /** Calls the OpenAPI; a JSON body is sent as JSON, a `FormData` body as multipart. */
  async request<T = any>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.accessToken()
    const headers: Record<string, string> = { authorization: `QQBot ${token}`, 'x-union-appid': this.options.appId }
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
    if (response.status === 401 && !retried) {
      this.invalidate()
      return this.request(method, path, body, true)
    }
    if (!response.ok) throw new QQApiError(`${method} ${path} failed: ${describeError(response.status, data)}`, response.status, data)
    return data as T
  }
}
