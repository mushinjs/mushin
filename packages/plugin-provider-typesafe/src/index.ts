import { type Context, field, z } from '@mushinjs/core'
import type {
  ChatResponse, DecisionAnswer, DecisionRequest, DecisionResponse, ProviderClient,
} from '@mushinjs/plugin-providers'

export const name = 'provider-typesafe'
export const inject = ['llm']

const TYPE = 'typesafe'
const OFFICIAL_BASE_URL = 'https://api.typesafe.ai'

export const ProviderConfig = z.object({
  apiKey: z.string().min(1).meta(field('API key', 'TypeSafe API key, or an OpenRouter key for the OpenRouter base URL', {
    'zh-CN': { title: 'API 密钥', description: 'TypeSafe API 密钥；接口地址为 OpenRouter 时填 OpenRouter 密钥' },
  })),
  baseURL: z.url().default(OFFICIAL_BASE_URL).meta(field('Base URL', 'Without /v1; https://openrouter.ai/api also serves Jev', {
    'zh-CN': { title: '接口地址', description: '不含 /v1；https://openrouter.ai/api 也提供 Jev' },
  })),
  longContext: z.boolean().default(false).meta(field('Long context', 'Allow states longer than the standard limit (sends TypeSafe-Danger-Zone-Long-Context)', {
    'zh-CN': { title: '长上下文', description: '允许超出标准长度的状态（发送 TypeSafe-Danger-Zone-Long-Context 头）' },
  })),
})

export type ProviderConfig = z.infer<typeof ProviderConfig>

/** An HTTP error from the TypeSafe API. `retryAfter` is in seconds, from a 429 response. */
export class TypeSafeError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message)
    this.name = 'TypeSafeError'
  }
}

const STATUS_TEXT: Record<number, string> = {
  401: 'the API key was rejected',
  413: 'the request is too large',
  415: 'the request is not JSON',
  429: 'rate limited',
  529: 'the service is overloaded',
}

/** Formats `detail` from a 400 (string or object) or 422 (list of `{ loc, msg }`) response. */
export function describeDetail(detail: unknown): string | undefined {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail.map((item) => {
      const loc = Array.isArray(item?.loc) ? item.loc.join('.') : undefined
      return loc ? `${loc}: ${item.msg}` : String(item?.msg ?? JSON.stringify(item))
    }).join('; ')
  }
  if (detail !== undefined && detail !== null) return JSON.stringify(detail)
}

/** The `/v1/systemone` body for a decision request, and whether it needs the images header. */
export function toJevRequest(request: DecisionRequest) {
  const assets = request.assets && Object.keys(request.assets).length
    ? Object.fromEntries(Object.entries(request.assets).map(([key, asset]) => [key, { type: asset.type, format: asset.format, data_base64: asset.data }]))
    : undefined
  const images = !!assets || Object.values(request.questions).some((question) => question.type === 'box')
  return {
    images,
    body: {
      model: request.model,
      state: request.state,
      questions: request.questions,
      ...(assets ? { assets } : {}),
    },
  }
}

interface JevResponse {
  model?: string
  answers?: Record<string, DecisionAnswer>
  usage?: { input_tokens?: number; output_tokens?: number }
}

export function fromJevResponse(data: JevResponse): DecisionResponse {
  return {
    answers: data.answers ?? {},
    ...(data.usage ? { usage: { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 } } : {}),
  }
}

export class TypeSafeClient implements ProviderClient {
  private baseURL: string

  constructor(private config: ProviderConfig, private fetcher: typeof fetch = fetch) {
    this.baseURL = config.baseURL.replace(/\/+$/, '')
  }

  private async request(path: string, init: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
    const response = await this.fetcher(`${this.baseURL}${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: init.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let detail: string | undefined
      try {
        detail = describeDetail(JSON.parse(text).detail)
      } catch {
        detail = text || undefined
      }
      const retry = response.headers.get('retry-after')
      const retryAfter = retry && Number.isFinite(Number(retry)) ? Number(retry) : undefined
      const reason = [STATUS_TEXT[response.status], detail].filter(Boolean).join(': ') || response.statusText
      throw new TypeSafeError(
        response.status,
        `TypeSafe API ${response.status}: ${reason}${retryAfter !== undefined ? ` (retry after ${retryAfter}s)` : ''}`,
        retryAfter,
      )
    }
    return response
  }

  async chat(): Promise<ChatResponse> {
    throw new TypeSafeError(400, 'TypeSafe Jev answers decisions only; use providers.decide')
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const { images, body } = toJevRequest(request)
    const response = await this.request('/v1/systemone', {
      body,
      headers: {
        ...(images ? { 'TypeSafe-Danger-Zone-Images': 'true' } : {}),
        ...(this.config.longContext ? { 'TypeSafe-Danger-Zone-Long-Context': 'true' } : {}),
      },
      signal: request.signal,
    })
    return fromJevResponse(await response.json() as JevResponse)
  }

  /** Model aliases the API lists, such as `jev-latest`. */
  async listModels(signal?: AbortSignal) {
    const response = await this.request('/v1/models', { signal })
    const data = await response.json() as { models?: { name: string }[] }
    return (data.models ?? []).map((model) => model.name)
  }
}

export function apply(ctx: Context) {
  ctx.llm.defineType({
    id: TYPE,
    displayName: 'TypeSafe Jev',
    config: ProviderConfig,
    secrets: ['apiKey'],
    capabilities: ['decision'],
    // API reference: https://docs.typesafe.ai. jev-latest and jev-preview both point at jev-1.14.0;
    // box questions and image assets need 1.14 or later.
    presets: [
      {
        id: 'typesafe',
        label: 'TypeSafe Jev',
        config: { baseURL: OFFICIAL_BASE_URL },
        models: ['jev-latest', 'jev-preview', 'jev-1.14.0', 'jev-1.13.0'],
      },
      {
        id: 'typesafe-openrouter',
        label: { en: 'TypeSafe Jev (OpenRouter)', 'zh-CN': 'TypeSafe Jev（OpenRouter）' },
        config: { baseURL: 'https://openrouter.ai/api' },
        models: ['typesafe/jev-1.13'],
      },
    ],
    create: (config) => new TypeSafeClient(config),
  })
}
