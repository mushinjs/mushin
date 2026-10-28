import type { JsonSchema, LocalizedText, Provenance, z } from '@mushin/core'

export interface ToolCall {
  id: string
  name: string
  /** JSON-encoded arguments, exactly as the model produced them. */
  arguments: string
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }

/**
 * A provider's own representation of an assistant turn. Clients of the same provider type
 * replay it verbatim, which keeps reasoning blocks valid across a tool loop.
 */
export interface RawTurn {
  type: string
  content: unknown
}

/** Vendor-neutral chat message. Provider clients convert to and from their SDK formats. */
export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; raw?: RawTurn }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean }

export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
}

export interface ChatRequest {
  model: string
  messages: LlmMessage[]
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

/**
 * Normalized stop reasons. `length` means the output hit the token limit, so any tool call in it
 * may be truncated and must not run; `refusal` means the model declined.
 */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'refusal' | 'other'

export interface ChatResponse {
  text: string
  toolCalls: ToolCall[]
  usage?: Usage
  finishReason?: FinishReason
  /** Native turn to replay on the next request; see {@link RawTurn}. */
  raw?: RawTurn
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; response: ChatResponse }

export interface EmbedRequest {
  model: string
  /** Texts to embed; `LlmService.embed()` sends at most `EMBED_BATCH` at a time. */
  input: string[]
  signal?: AbortSignal
}

export interface EmbedResponse {
  /** One vector per input, in order. */
  vectors: number[][]
  usage?: { inputTokens: number }
}

export interface ProviderClient {
  chat(request: ChatRequest): Promise<ChatResponse>
  /** Optional token streaming; callers fall back to `chat` when it is missing. */
  stream?(request: ChatRequest): AsyncIterable<StreamEvent>
  /** Optional text embeddings, for knowledge bases; providers without them (such as Anthropic) leave it out. */
  embed?(request: EmbedRequest): Promise<EmbedResponse>
  listModels?(signal?: AbortSignal): Promise<string[]>
}

export interface ProviderPreset {
  id: string
  label: LocalizedText
  config: Record<string, unknown>
  /** Suggested models; the dashboard can also fetch the live list. */
  models?: string[]
}

export interface ProviderType<C = any> {
  id: string
  displayName: LocalizedText
  config: z.ZodType<C>
  /** Config keys that hold secrets; they are masked in every API response. */
  secrets?: string[]
  presets?: ProviderPreset[]
  create(config: C): ProviderClient
}

export interface ProviderTest {
  ok: boolean
  at: number
  latencyMs?: number
  model?: string
  error?: string
}

export interface ProviderRecord {
  id: string
  name: string
  type: string
  config: Record<string, any>
  models: string[]
  defaultModel?: string
  isDefault?: boolean
  lastTest?: ProviderTest
  createdAt: number
}

export interface LlmChatOptions extends Omit<ChatRequest, 'model'> {
  /** Provider record id; the default provider when omitted. */
  provider?: string
  /** Model name; the provider's default model when omitted. */
  model?: string
}

export interface LlmEmbedOptions {
  /** Provider record id; the default provider when omitted. */
  provider?: string
  /** Embedding model name; required, since a provider's default model is a chat model. */
  model: string
  texts: string[]
  signal?: AbortSignal
}

export interface LlmEmbedResult {
  vectors: number[][]
  provider: string
  model: string
  /** Length of each vector. */
  dimension: number
  tokens?: number
}

/** A chat result that remembers where it came from, so a bot reply can show its source. */
export interface LlmResult extends ChatResponse {
  provider: string
  providerName: string
  model: string
  latencyMs: number
  source: Extract<Provenance, { kind: 'llm' }>
}
