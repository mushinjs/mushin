import OpenAI, { AzureOpenAI } from 'openai'
import { type Context, field, z } from '@mushinjs/core'
import type {
  ChatRequest, ChatResponse, EmbedRequest, EmbedResponse, FinishReason, LlmMessage, ProviderClient, StreamEvent, ToolCall,
} from '@mushinjs/plugin-providers'
import { responsesChat, responsesStream } from './responses'

export const name = 'provider-openai'
export const inject = ['llm']

export const ProviderConfig = z.object({
  baseURL: z.url().default('https://api.openai.com/v1').meta(field('Base URL', 'API address; ends in /v1 for most services', {
    'zh-CN': { title: '接口地址', description: 'API 地址，大多数服务以 /v1 结尾' },
  })),
  apiKey: z.string().default('').meta(field('API key', 'Leave empty for local servers such as Ollama', {
    'zh-CN': { title: 'API 密钥', description: 'Ollama 等本地服务可以留空' },
  })),
  api: z.enum(['auto', 'responses', 'chat']).default('auto').meta(field('API', 'Responses is the newer OpenAI API, which lets reasoning models use tools with a reasoning effort; most compatible services only have Chat Completions. Auto uses Responses for api.openai.com only', {
    'zh-CN': { title: '接口类型', description: 'Responses 是 OpenAI 的新接口，推理模型可以同时使用工具和推理强度；大多数兼容服务只有 Chat Completions。自动：只有 api.openai.com 用 Responses', options: { auto: '自动' } },
  }, { options: { auto: 'Auto', responses: 'Responses', chat: 'Chat Completions' } })),
  headers: z.record(z.string(), z.string()).optional().meta(field('Extra headers', 'Additional HTTP headers as a JSON object', {
    'zh-CN': { title: '额外请求头', description: '以 JSON 对象填写的额外 HTTP 请求头' },
  })),
})

export type ProviderConfig = z.infer<typeof ProviderConfig>

export const AzureConfig = z.object({
  endpoint: z.url().meta(field('Endpoint', 'Resource endpoint, such as https://my-resource.openai.azure.com', {
    'zh-CN': { title: '终结点', description: '资源终结点，例如 https://my-resource.openai.azure.com' },
  })),
  apiKey: z.string().min(1).meta(field('API key', 'Key of the Azure OpenAI resource', {
    'zh-CN': { title: 'API 密钥', description: 'Azure OpenAI 资源的密钥' },
  })),
  apiVersion: z.string().min(1).default('2024-10-21').meta(field('API version', 'The api-version query parameter', {
    'zh-CN': { title: 'API 版本', description: '请求的 api-version 参数' },
  })),
  deployment: z.string().optional().meta(field('Deployment', 'Send every request to this deployment; when empty, the model name is used as the deployment name', {
    'zh-CN': { title: '部署名称', description: '所有请求都发往此部署；留空时把模型名当作部署名' },
  })),
})

export type AzureConfig = z.infer<typeof AzureConfig>

type Params = OpenAI.Chat.Completions.ChatCompletionCreateParams

function toFinishReason(reason: string | null | undefined): FinishReason | undefined {
  if (!reason) return
  if (reason === 'stop') return 'stop'
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_calls'
  if (reason === 'length') return 'length'
  if (reason === 'content_filter') return 'refusal'
  return 'other'
}

function toOpenAIMessages(messages: LlmMessage[]): Params['messages'] {
  return messages.map((message): Params['messages'][number] => {
    switch (message.role) {
      case 'system':
        return { role: 'system', content: message.content }
      case 'user':
        if (typeof message.content === 'string') return { role: 'user', content: message.content }
        return {
          role: 'user',
          content: message.content.map((part) => part.type === 'text'
            ? { type: 'text' as const, text: part.text }
            : { type: 'image_url' as const, image_url: { url: part.url } }),
        }
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content || null,
          ...(message.toolCalls?.length ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          } : {}),
        }
      case 'tool':
        return {
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: message.isError ? `Error: ${message.content}` : message.content,
        }
    }
  })
}

export interface OpenAIClientOptions {
  /** Send the token limit as `max_completion_tokens` rather than the older `max_tokens`. */
  completionTokens?: boolean
  /** Chat through the Responses API instead of Chat Completions. */
  responses?: boolean
}

/** Chat, streaming, embeddings and model lists over any OpenAI SDK client, plain or Azure. */
export class OpenAIClient implements ProviderClient {
  /** Models that refused reasoning_effort together with tools; their tool requests leave the effort out. */
  private noEffortWithTools = new Set<string>()

  constructor(private sdk: OpenAI, private options: OpenAIClientOptions = {}) {}

  /**
   * Some models refuse reasoning_effort in a Chat Completions request that carries tools. Such a request is sent
   * again without it, and later ones for that model leave it out.
   */
  private async create<T>(request: ChatRequest, send: (params: ReturnType<OpenAIClient['params']>) => Promise<T>): Promise<{ value: T; effortIgnored: boolean }> {
    const params = this.params(request)
    const effortIgnored = !!request.effort && !('reasoning_effort' in params)
    try {
      return { value: await send(params), effortIgnored }
    } catch (error) {
      if (!('reasoning_effort' in params) || !request.tools?.length || !(error instanceof OpenAI.APIError) || error.status !== 400 || !/reasoning_effort/.test(error.message)) throw error
      this.noEffortWithTools.add(request.model)
      return { value: await send(this.params(request)), effortIgnored: true }
    }
  }

  static fromConfig(config: ProviderConfig) {
    const sdk = new OpenAI({
      baseURL: config.baseURL,
      // The SDK refuses an empty key; local servers ignore it.
      apiKey: config.apiKey || 'not-needed',
      defaultHeaders: config.headers,
      maxRetries: 1,
    })
    // OpenAI's own API wants max_completion_tokens; compatible services still expect max_tokens.
    const official = new URL(config.baseURL).hostname === 'api.openai.com'
    return new OpenAIClient(sdk, { completionTokens: official, responses: config.api === 'responses' || (config.api !== 'chat' && official) })
  }

  /** `fetch` replaces the SDK's HTTP client, for tests. */
  static fromAzure(config: AzureConfig, fetch?: typeof globalThis.fetch) {
    const sdk = new AzureOpenAI({
      ...(fetch ? { fetch } : {}),
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      apiVersion: config.apiVersion,
      ...(config.deployment ? { deployment: config.deployment } : {}),
      maxRetries: 1,
    })
    // Azure takes max_completion_tokens on every current API version, and reasoning models require it.
    return new OpenAIClient(sdk, { completionTokens: true })
  }

  /** Request body without `stream`; exposed for tests. */
  params(request: ChatRequest) {
    return {
      model: request.model,
      messages: toOpenAIMessages(request.messages),
      ...(request.tools?.length ? {
        tools: request.tools.map((tool) => ({
          type: 'function' as const,
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
      } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      // OpenAI's highest level is xhigh; compatible services that do not reason ignore the field or reject it.
      ...(request.effort && !(request.tools?.length && this.noEffortWithTools.has(request.model)) ? { reasoning_effort: (request.effort === 'max' ? 'xhigh' : request.effort) as 'high' } : {}),
      ...(request.maxTokens !== undefined
        ? this.options.completionTokens ? { max_completion_tokens: request.maxTokens } : { max_tokens: request.maxTokens }
        : {}),
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (this.options.responses) return responsesChat(this.sdk, request)
    const { value: completion, effortIgnored } = await this.create(request, (params) => this.sdk.chat.completions.create(
      { ...params, stream: false },
      { signal: request.signal },
    ))
    const choice = completion.choices[0]
    const toolCalls: ToolCall[] = (choice?.message.tool_calls ?? []).flatMap((call) => call.type === 'function'
      ? [{ id: call.id, name: call.function.name, arguments: call.function.arguments || '{}' }]
      : [])
    return {
      text: choice?.message.content ?? '',
      toolCalls,
      finishReason: toFinishReason(choice?.finish_reason),
      usage: completion.usage
        ? { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens }
        : undefined,
      ...(effortIgnored ? { effortIgnored } : {}),
    }
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.options.responses) {
      yield* responsesStream(this.sdk, request)
      return
    }
    const { value: stream, effortIgnored } = await this.create(request, (params) => this.sdk.chat.completions.create(
      { ...params, stream: true, stream_options: { include_usage: true } },
      { signal: request.signal },
    ))
    let text = ''
    let finishReason: FinishReason | undefined
    let usage: ChatResponse['usage']
    const calls = new Map<number, ToolCall>()
    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens }
      }
      const choice = chunk.choices[0]
      if (!choice) continue
      if (choice.finish_reason) finishReason = toFinishReason(choice.finish_reason)
      const delta = choice.delta
      if (delta?.content) {
        text += delta.content
        yield { type: 'delta', text: delta.content }
      }
      for (const part of delta?.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' }
        if (part.id) call.id = part.id
        if (part.function?.name) call.name += part.function.name
        if (part.function?.arguments) call.arguments += part.function.arguments
        calls.set(part.index, call)
      }
    }
    const toolCalls = [...calls.values()].map((call) => ({ ...call, arguments: call.arguments || '{}' }))
    yield { type: 'done', response: { text, toolCalls, finishReason, usage, ...(effortIgnored ? { effortIgnored } : {}) } }
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    const response = await this.sdk.embeddings.create(
      { model: request.model, input: request.input, encoding_format: 'float' },
      { signal: request.signal },
    )
    const vectors = [...response.data].sort((a, b) => a.index - b.index).map((item) => item.embedding)
    return { vectors, ...(response.usage ? { usage: { inputTokens: response.usage.prompt_tokens } } : {}) }
  }

  async listModels(signal?: AbortSignal) {
    const models: { id: string; created?: number }[] = []
    for await (const model of this.sdk.models.list({ signal })) models.push({ id: model.id, created: (model as { created?: number }).created })
    // Newest first, by release time where the service gives one; compatible services that leave it out keep name order.
    return models.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id)).map((model) => model.id)
  }
}

export function apply(ctx: Context) {
  ctx.llm.defineType({
    id: 'openai',
    displayName: { en: 'OpenAI-compatible', 'zh-CN': 'OpenAI 兼容' },
    config: ProviderConfig,
    secrets: ['apiKey'],
    presets: [
      { id: 'openai', label: 'OpenAI', config: { baseURL: 'https://api.openai.com/v1' } },
      { id: 'deepseek', label: 'DeepSeek', config: { baseURL: 'https://api.deepseek.com/v1' } },
      { id: 'moonshot', label: { en: 'Moonshot (Kimi)', 'zh-CN': '月之暗面 Kimi' }, config: { baseURL: 'https://api.moonshot.cn/v1' } },
      { id: 'qwen', label: { en: 'Qwen (DashScope)', 'zh-CN': '通义千问（百炼）' }, config: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } },
      { id: 'siliconflow', label: { en: 'SiliconFlow', 'zh-CN': '硅基流动' }, config: { baseURL: 'https://api.siliconflow.cn/v1' } },
      { id: 'openrouter', label: 'OpenRouter', config: { baseURL: 'https://openrouter.ai/api/v1' } },
      { id: 'zhipu', label: { en: 'Zhipu GLM', 'zh-CN': '智谱 GLM' }, config: { baseURL: 'https://open.bigmodel.cn/api/paas/v4' } },
      { id: 'volcengine-ark', label: { en: 'Volcengine Ark (Doubao)', 'zh-CN': '火山方舟（豆包）' }, config: { baseURL: 'https://ark.cn-beijing.volces.com/api/v3' } },
      { id: 'qianfan', label: { en: 'Baidu Qianfan', 'zh-CN': '百度千帆' }, config: { baseURL: 'https://qianfan.baidubce.com/v2' } },
      { id: 'hunyuan', label: { en: 'Tencent Hunyuan', 'zh-CN': '腾讯混元' }, config: { baseURL: 'https://api.hunyuan.cloud.tencent.com/v1' } },
      { id: 'minimax', label: 'MiniMax', config: { baseURL: 'https://api.minimaxi.com/v1' } },
      { id: 'stepfun', label: { en: 'StepFun', 'zh-CN': '阶跃星辰' }, config: { baseURL: 'https://api.stepfun.com/v1' } },
      { id: 'xai', label: 'xAI (Grok)', config: { baseURL: 'https://api.x.ai/v1' } },
      { id: 'groq', label: 'Groq', config: { baseURL: 'https://api.groq.com/openai/v1' } },
      { id: 'mistral', label: 'Mistral', config: { baseURL: 'https://api.mistral.ai/v1' } },
      { id: 'gemini-openai', label: { en: 'Gemini (OpenAI-compatible)', 'zh-CN': 'Gemini（OpenAI 兼容）' }, config: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' } },
      { id: 'together', label: 'Together AI', config: { baseURL: 'https://api.together.xyz/v1' } },
      { id: 'ollama', label: { en: 'Ollama (local)', 'zh-CN': 'Ollama（本地）' }, config: { baseURL: 'http://127.0.0.1:11434/v1', apiKey: '' } },
      { id: 'lmstudio', label: { en: 'LM Studio (local)', 'zh-CN': 'LM Studio（本地）' }, config: { baseURL: 'http://127.0.0.1:1234/v1', apiKey: '' } },
      { id: 'vllm', label: { en: 'vLLM (local)', 'zh-CN': 'vLLM（本地）' }, config: { baseURL: 'http://127.0.0.1:8000/v1', apiKey: '' } },
    ],
    create: (config) => OpenAIClient.fromConfig(config),
  })

  ctx.llm.defineType({
    id: 'azure-openai',
    displayName: 'Azure OpenAI',
    config: AzureConfig,
    secrets: ['apiKey'],
    presets: [{ id: 'azure-openai', label: 'Azure OpenAI', config: { apiVersion: '2024-10-21' } }],
    create: (config) => OpenAIClient.fromAzure(config),
  })
}
