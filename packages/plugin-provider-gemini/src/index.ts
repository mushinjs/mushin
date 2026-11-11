import { type Context, field, z } from '@mushinjs/core'
import type {
  ChatRequest, ChatResponse, EmbedRequest, EmbedResponse, ProviderClient, StreamEvent,
} from '@mushinjs/plugin-providers'
import { fromParts, fromResponse, type GeminiPart, type GeminiResponse, mergeParts, toGeminiRequest, TYPE } from './convert'

export * from './convert'

export const name = 'provider-gemini'
export const inject = ['llm']

const OFFICIAL_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

export const ProviderConfig = z.object({
  apiKey: z.string().min(1).meta(field('API key', 'Gemini API key from Google AI Studio', {
    'zh-CN': { title: 'API 密钥', description: '在 Google AI Studio 获取的 Gemini API 密钥' },
  })),
  baseURL: z.url().default(OFFICIAL_BASE_URL).meta(field('Base URL', 'Change only when routing through a proxy; ends in /v1beta', {
    'zh-CN': { title: '接口地址', description: '仅在使用代理时修改，以 /v1beta 结尾' },
  })),
})

export type ProviderConfig = z.infer<typeof ProviderConfig>

/** An HTTP error from the Gemini API, with its status code. */
export class GeminiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'GeminiError'
  }
}

/** Accepts `gemini-x` and `models/gemini-x`. */
function modelPath(model: string) {
  return model.startsWith('models/') ? model : `models/${model}`
}

/** Reads `data:` lines from a server-sent event stream as parsed JSON. */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<GeminiResponse> {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let index: number
      while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const event = buffer.slice(0, index)
        buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, '')
        const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
        if (data) yield JSON.parse(data)
      }
      if (done) break
    }
    const data = buffer.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
    if (data) yield JSON.parse(data)
  } finally {
    reader.releaseLock()
  }
}

export class GeminiClient implements ProviderClient {
  private baseURL: string

  constructor(private config: ProviderConfig, private fetcher: typeof fetch = fetch) {
    this.baseURL = config.baseURL.replace(/\/+$/, '')
  }

  private async request(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}) {
    const response = await this.fetcher(`${this.baseURL}/${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { 'x-goog-api-key': this.config.apiKey, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: init.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let message = text || response.statusText
      try {
        message = JSON.parse(text).error?.message ?? message
      } catch {}
      throw new GeminiError(response.status, `Gemini API ${response.status}: ${message}`)
    }
    return response
  }

  /** Downloads an http(s) image so it can go inline; the API does not fetch arbitrary URLs itself. */
  private download = async (url: string) => {
    const response = await this.fetcher(url)
    if (!response.ok) throw new Error(`Could not download image ${url}: HTTP ${response.status}`)
    const mimeType = response.headers.get('content-type')?.split(';')[0].trim() || 'image/jpeg'
    const data = Buffer.from(await response.arrayBuffer()).toString('base64')
    return { mimeType, data }
  }

  private body(request: ChatRequest) {
    return toGeminiRequest(request.messages, {
      tools: request.tools,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      download: this.download,
    })
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.request(`${modelPath(request.model)}:generateContent`, {
      body: await this.body(request),
      signal: request.signal,
    })
    return fromResponse(await response.json() as GeminiResponse)
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const response = await this.request(`${modelPath(request.model)}:streamGenerateContent?alt=sse`, {
      body: await this.body(request),
      signal: request.signal,
    })
    if (!response.body) throw new GeminiError(response.status, 'Gemini API returned an empty stream')
    const parts: GeminiPart[] = []
    let finishReason: string | undefined
    let blockReason: string | undefined
    let usage: GeminiResponse['usageMetadata']
    for await (const chunk of readEvents(response.body)) {
      const candidate = chunk.candidates?.[0]
      const incoming = candidate?.content?.parts ?? []
      for (const part of incoming) {
        if (part.text && !part.thought) yield { type: 'delta', text: part.text }
      }
      mergeParts(parts, incoming)
      finishReason = candidate?.finishReason ?? finishReason
      blockReason = chunk.promptFeedback?.blockReason ?? blockReason
      usage = chunk.usageMetadata ?? usage
    }
    yield { type: 'done', response: fromParts(parts, { finishReason, blockReason, usage }) }
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    const model = modelPath(request.model)
    const response = await this.request(`${model}:batchEmbedContents`, {
      body: { requests: request.input.map((text) => ({ model, content: { parts: [{ text }] } })) },
      signal: request.signal,
    })
    const data = await response.json() as { embeddings?: { values: number[] }[] }
    return { vectors: (data.embeddings ?? []).map((item) => item.values) }
  }

  /** Models that can chat, without the `models/` prefix. */
  async listModels(signal?: AbortSignal) {
    const models: string[] = []
    let pageToken: string | undefined
    do {
      const query = new URLSearchParams({ pageSize: '1000', ...(pageToken ? { pageToken } : {}) })
      const response = await this.request(`models?${query}`, { signal })
      const data = await response.json() as { models?: { name: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string }
      for (const model of data.models ?? []) {
        if (model.supportedGenerationMethods?.includes('generateContent')) models.push(model.name.replace(/^models\//, ''))
      }
      pageToken = data.nextPageToken
    } while (pageToken)
    return models.sort()
  }
}

export function apply(ctx: Context) {
  ctx.llm.defineType({
    id: TYPE,
    displayName: 'Google Gemini',
    config: ProviderConfig,
    secrets: ['apiKey'],
    presets: [{ id: 'gemini', label: 'Google Gemini', config: { baseURL: OFFICIAL_BASE_URL } }],
    create: (config) => new GeminiClient(config),
  })
}
