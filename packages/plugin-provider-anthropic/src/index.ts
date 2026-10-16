import Anthropic from '@anthropic-ai/sdk'
import { type Context, field, z } from '@mushin/core'
import type {
  ChatRequest, ChatResponse, FinishReason, LlmMessage, ProviderClient, StreamEvent, ToolCall,
} from '@mushin/plugin-providers'

export const name = 'provider-anthropic'
export const inject = ['llm']

const OFFICIAL_BASE_URL = 'https://api.anthropic.com'

export const ProviderConfig = z.object({
  apiKey: z.string().min(1).meta(field('API key', 'Anthropic API key', {
    'zh-CN': { title: 'API 密钥', description: 'Anthropic API 密钥' },
  })),
  baseURL: z.url().default(OFFICIAL_BASE_URL).meta(field('Base URL', 'Change only when routing through a proxy', {
    'zh-CN': { title: '接口地址', description: '仅在使用代理时修改' },
  })),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().meta(field('Effort', 'How much the model thinks; empty means the model default', {
    'zh-CN': { title: '思考强度', description: '模型思考的程度；留空使用模型默认值' },
  })),
  refusalFallback: z.boolean().default(true).meta(field('Refusal fallback', 'When a safety classifier declines a request, let the API retry it on a fallback model', {
    'zh-CN': { title: '拒答回退', description: '安全分类器拒绝请求时，由 API 自动改用后备模型重试' },
  })),
})

export type ProviderConfig = z.infer<typeof ProviderConfig>

// Models that accept the server-side `fallbacks: "default"` refusal fallback on the Claude API.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

const TYPE = 'anthropic'

function toFinishReason(reason: string | null | undefined): FinishReason | undefined {
  switch (reason) {
    case undefined:
    case null:
      return
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'tool_use':
      return 'tool_calls'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length'
    case 'refusal':
      return 'refusal'
    default:
      return 'other'
  }
}

function toImageSource(url: string): Anthropic.ImageBlockParam['source'] {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(url)
  if (match) return { type: 'base64', media_type: match[1] as 'image/png', data: match[2] }
  return { type: 'url', url }
}

/**
 * Converts neutral messages to Anthropic's shape. Assistant turns produced by this provider are
 * replayed verbatim (thinking blocks included); consecutive tool results share one user message.
 */
export function toAnthropicMessages(messages: LlmMessage[]) {
  const system: string[] = []
  const result: Anthropic.MessageParam[] = []
  const pushUser = (blocks: Anthropic.ContentBlockParam[]) => {
    const last = result.at(-1)
    if (last?.role === 'user' && Array.isArray(last.content)) {
      last.content.push(...blocks)
    } else {
      result.push({ role: 'user', content: blocks })
    }
  }

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        // Only leading system text goes to the top-level `system` field; it must stay stable.
        if (!result.length) system.push(message.content)
        else pushUser([{ type: 'text', text: message.content }])
        break
      case 'user':
        pushUser(typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : message.content.map((part): Anthropic.ContentBlockParam => part.type === 'text'
            ? { type: 'text', text: part.text }
            : { type: 'image', source: toImageSource(part.url) }))
        break
      case 'assistant':
        if (message.raw?.type === TYPE) {
          result.push({ role: 'assistant', content: message.raw.content as Anthropic.ContentBlockParam[] })
        } else {
          const content: Anthropic.ContentBlockParam[] = []
          if (message.content) content.push({ type: 'text', text: message.content })
          for (const call of message.toolCalls ?? []) {
            content.push({ type: 'tool_use', id: call.id, name: call.name, input: safeParse(call.arguments) })
          }
          if (content.length) result.push({ role: 'assistant', content })
        }
        break
      case 'tool':
        pushUser([{
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
          ...(message.isError ? { is_error: true } : {}),
        }])
        break
    }
  }
  return { system: system.join('\n\n') || undefined, messages: result }
}

function safeParse(json: string) {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

function fromMessage(message: Anthropic.Message | Anthropic.Beta.BetaMessage): ChatResponse {
  let text = ''
  const toolCalls: ToolCall[] = []
  for (const block of message.content) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) })
    }
  }
  return {
    text,
    toolCalls,
    finishReason: toFinishReason(message.stop_reason),
    usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    // Replayed unchanged on the next request so preserved thinking stays valid.
    raw: { type: TYPE, content: message.content },
  }
}

export class AnthropicClient implements ProviderClient {
  private sdk: Anthropic
  private official: boolean

  constructor(private config: ProviderConfig) {
    this.sdk = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 2 })
    this.official = new URL(config.baseURL).origin === OFFICIAL_BASE_URL
  }

  private params(request: ChatRequest, streaming: boolean) {
    const { system, messages } = toAnthropicMessages(request.messages)
    const fallback = this.config.refusalFallback && this.official && FALLBACK_MODELS.has(request.model)
    return {
      fallback,
      body: {
        model: request.model,
        max_tokens: request.maxTokens ?? (streaming ? 64000 : 16000),
        messages,
        ...(system ? { system } : {}),
        ...(request.tools?.length ? {
          tools: request.tools.map((tool): Anthropic.Tool => ({
            name: tool.name,
            description: tool.description,
            input_schema: { type: 'object', ...tool.parameters },
            // Stream tool input as it is generated. A proxy may reject the field, so only on the official API.
            ...(streaming && this.official ? { eager_input_streaming: true } : {}),
          })),
        } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(this.config.effort ? { output_config: { effort: this.config.effort } } : {}),
      } satisfies Anthropic.MessageCreateParamsNonStreaming,
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { fallback, body } = this.params(request, false)
    const message = fallback
      ? await this.sdk.beta.messages.create(
        { ...body, betas: [FALLBACK_BETA], fallbacks: 'default' } as Anthropic.Beta.MessageCreateParamsNonStreaming,
        { signal: request.signal },
      )
      : await this.sdk.messages.create(body, { signal: request.signal })
    return fromMessage(message)
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const { fallback, body } = this.params(request, true)
    // With eager input streaming the SDK rejects finalMessage() when a tool input is not parseable
    // JSON. Re-issue that turn up to twice; API errors are rethrown as they are.
    for (let attempt = 0; ; attempt++) {
      const stream = fallback
        ? this.sdk.beta.messages.stream(
          { ...body, betas: [FALLBACK_BETA], fallbacks: 'default' } as Anthropic.Beta.MessageCreateParamsNonStreaming,
          { signal: request.signal },
        )
        : this.sdk.messages.stream(body, { signal: request.signal })
      let emitted = false
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            emitted = true
            yield { type: 'delta', text: event.delta.text }
          }
        }
        yield { type: 'done', response: fromMessage(await stream.finalMessage()) }
        return
      } catch (error) {
        if (error instanceof Anthropic.APIError || emitted || attempt >= 2) throw error
      }
    }
  }

  async listModels(signal?: AbortSignal) {
    const models: string[] = []
    for await (const model of this.sdk.models.list({}, { signal })) models.push(model.id)
    return models
  }
}

export function apply(ctx: Context) {
  ctx.llm.defineType({
    id: TYPE,
    displayName: 'Anthropic',
    config: ProviderConfig,
    secrets: ['apiKey'],
    presets: [{
      id: 'anthropic',
      label: 'Anthropic (Claude)',
      config: { baseURL: OFFICIAL_BASE_URL },
      models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    }],
    create: (config) => new AnthropicClient(config),
  })
}
