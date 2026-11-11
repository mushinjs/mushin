import type { JsonSchema, LocalizedText, Provenance, z } from '@mushinjs/core'

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

/**
 * A question for a decision model. `noul` asks for a probability that a statement holds;
 * `choice` picks one of the named options; `score` grades on an ordered scale whose index is the
 * score; `box` locates something in an image asset.
 */
export type DecisionQuestion =
  | { type: 'noul'; instructions?: DecisionText; criteria?: { true?: DecisionText; false?: DecisionText } }
  /** 1 to 255 options; a null description means the option name speaks for itself. */
  | { type: 'choice'; instructions?: DecisionText; criteria: Record<string, DecisionText> }
  /** 1 to 10 ordered levels; the score is the probability-weighted mean of the level indexes. */
  | { type: 'score'; instructions?: DecisionText; criteria: DecisionText[] }
  | { type: 'box'; instructions?: DecisionText }

/** Instructions and criteria may be text or any JSON value; null means none. */
export type DecisionText = string | Record<string, unknown> | unknown[] | null

/** An image the state refers to by its placeholder name. */
export interface DecisionAsset {
  type: 'image'
  format: 'png' | 'jpg' | 'jpeg'
  /** Base64 data without a `data:` prefix. */
  data: string
}

export interface DecisionRequest {
  model: string
  /** What to decide about: text, or any JSON value. */
  state: string | Record<string, unknown> | unknown[]
  questions: Record<string, DecisionQuestion>
  assets?: Record<string, DecisionAsset>
  signal?: AbortSignal
}

export type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; legend: Record<string, string>; probabilities: Record<string, number> }
  /** Edges as fractions from 0 to 1: top and bottom of the image height, left and right of its width. */
  | { type: 'box'; box: { top: number; bottom: number; left: number; right: number }; confidence: number | null }

export interface DecisionResponse {
  /** One answer per question name. */
  answers: Record<string, DecisionAnswer>
  usage?: Usage
}

export interface ProviderClient {
  chat(request: ChatRequest): Promise<ChatResponse>
  /** Optional token streaming; callers fall back to `chat` when it is missing. */
  stream?(request: ChatRequest): AsyncIterable<StreamEvent>
  /** Optional text embeddings, for knowledge bases; providers without them (such as Anthropic) leave it out. */
  embed?(request: EmbedRequest): Promise<EmbedResponse>
  listModels?(signal?: AbortSignal): Promise<string[]>
  /** Optional structured decisions, for decision models that do not chat. */
  decide?(request: DecisionRequest): Promise<DecisionResponse>
}

/** What a provider type can do; `chat` covers `chat`, `stream` and `embed`. */
export type ProviderCapability = 'chat' | 'decision'

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
  /** Defaults to `['chat']`. A type without `chat` is never picked for chat requests. */
  capabilities?: ProviderCapability[]
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

/** One model of a profile: a model name on a saved provider. */
export interface ProfileModel {
  provider: string
  model: string
}

/**
 * A named choice of model with fallbacks. The first model answers; when a request to it fails,
 * the next one is tried, and so on. A profile id works wherever a provider id is taken.
 */
export interface ModelProfile {
  id: string
  name: string
  models: ProfileModel[]
  createdAt: number
}

export interface LlmChatOptions extends Omit<ChatRequest, 'model'> {
  /** Provider record id or profile id; the default provider when omitted. */
  provider?: string
  /** Model name; the provider's default model when omitted. Ignored for a profile, which names its own models. */
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

export interface LlmDecideOptions extends Omit<DecisionRequest, 'model'> {
  /** Provider record id; the default decision provider when omitted. */
  provider?: string
  /** Model name; the provider's default model when omitted. */
  model?: string
}

export interface LlmDecideResult extends DecisionResponse {
  provider: string
  providerName: string
  model: string
  latencyMs: number
}

/** A chat result that remembers where it came from, so a bot reply can show its source. */
export interface LlmResult extends ChatResponse {
  provider: string
  providerName: string
  model: string
  latencyMs: number
  source: Extract<Provenance, { kind: 'llm' }>
}
