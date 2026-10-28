import { Context, isMasked, mask, MushinError, randomId, Service, toJsonSchema, z } from '@mushin/core'
import type {} from '@mushin/plugin-storage'
import type {
  ChatRequest, LlmChatOptions, LlmEmbedOptions, LlmEmbedResult, LlmResult, ProviderClient, ProviderRecord, ProviderTest, ProviderType, StreamEvent,
} from './types'

export * from './types'

declare module '@mushin/core' {
  interface Context {
    llm: LlmService
  }

  interface Events {
    'providers/changed'(): void
    'llm/called'(call: LlmCall): void
  }
}

/** One finished model request, for usage statistics. */
export interface LlmCall {
  provider: string
  providerName: string
  model: string
  ok: boolean
  inputTokens?: number
  outputTokens?: number
  latencyMs: number
}

const STORAGE_KEY = 'providers'

/** Most texts sent in one embedding request. */
export const EMBED_BATCH = 64

interface StoredProviders {
  providers: ProviderRecord[]
}

const providerInput = z.object({
  name: z.string().min(1).describe('Display name, such as "DeepSeek"'),
  type: z.string().describe('Provider type id from providers.types, such as "openai" or "anthropic"'),
  config: z.record(z.string(), z.any()).describe('Config matching the type\'s schema from providers.types'),
  models: z.array(z.string()).optional().describe('Models offered by this provider'),
  defaultModel: z.string().optional(),
  isDefault: z.boolean().optional().describe('Make this the default provider'),
})

/**
 * Owns provider records and exposes one `chat` entry point.
 * Provider types (OpenAI-compatible, Anthropic, ...) are registered by other plugins.
 */
export class LlmService extends Service {
  static inject = ['storage', 'actions']

  private home: Context
  private typeStore = new Map<string, ProviderType>()
  private records: ProviderRecord[] = []
  private clients = new Map<string, { key: string; client: ProviderClient }>()

  constructor(ctx: Context) {
    super(ctx, 'llm')
    this.home = ctx
  }

  /** Provider lifecycle lines, tagged `provider` in the dashboard. Never includes config values. */
  private get logger() {
    return this.home.logger('provider')
  }

  async *[Service.init]() {
    const stored = await this.home.storage.get<StoredProviders>(STORAGE_KEY)
    this.records = stored?.providers ?? []
    this.logger.info('loaded %d provider(s)', this.records.length)
    yield* this.defineActions()
  }

  /** Registers a provider type. It is removed when the calling plugin unloads. */
  defineType<C>(type: ProviderType<C>) {
    const ctx = this.ctx
    return ctx.effect(() => {
      if (this.typeStore.has(type.id)) throw new Error(`provider type "${type.id}" is already defined`)
      this.typeStore.set(type.id, type)
      this.logger.info('provider type %s is available', type.id)
      ctx.emit('providers/changed')
      return () => {
        this.typeStore.delete(type.id)
        this.logger.info('provider type %s was removed', type.id)
        for (const record of this.records) {
          if (record.type === type.id) this.clients.delete(record.id)
        }
        ctx.emit('providers/changed')
      }
    }, `llm.defineType(${type.id})`)
  }

  types() {
    return [...this.typeStore.values()].map((type) => ({
      id: type.id,
      displayName: type.displayName,
      configSchema: toJsonSchema(type.config),
      secrets: type.secrets ?? [],
      presets: type.presets ?? [],
    }))
  }

  list() {
    return this.records.map((record) => this.redact(record))
  }

  get(id: string) {
    const record = this.records.find((item) => item.id === id)
    if (!record) throw new MushinError('not_found', `No provider with id "${id}"`)
    return record
  }

  /** The default provider, or the first one if none is marked default. */
  defaultProvider() {
    return this.records.find((record) => record.isDefault) ?? this.records[0]
  }

  /** True when at least one provider has passed its connection test. */
  isReady() {
    return this.records.some((record) => record.lastTest?.ok)
  }

  private redact(record: ProviderRecord) {
    const secrets = this.typeStore.get(record.type)?.secrets ?? []
    const config = { ...record.config }
    for (const key of secrets) {
      if (typeof config[key] === 'string') config[key] = mask(config[key])
    }
    return { ...record, config, typeAvailable: this.typeStore.has(record.type) }
  }

  private requireType(id: string) {
    const type = this.typeStore.get(id)
    if (!type) {
      const known = [...this.typeStore.keys()].join(', ') || 'none'
      throw new MushinError('invalid_input', `Unknown provider type "${id}". Available types: ${known}`)
    }
    return type
  }

  private validateConfig(type: ProviderType, config: unknown) {
    const result = type.config.safeParse(config)
    if (!result.success) throw new MushinError('invalid_input', z.prettifyError(result.error), result.error.issues)
    return result.data as Record<string, any>
  }

  private async save() {
    await this.home.storage.set(STORAGE_KEY, { providers: this.records } satisfies StoredProviders)
    this.home.emit('providers/changed')
  }

  async create(input: z.infer<typeof providerInput>) {
    const type = this.requireType(input.type)
    const record: ProviderRecord = {
      id: randomId(),
      name: input.name,
      type: input.type,
      config: this.validateConfig(type, input.config),
      models: input.models ?? [],
      defaultModel: input.defaultModel ?? input.models?.[0],
      createdAt: Date.now(),
    }
    if (input.isDefault || !this.records.length) this.markDefault(record)
    this.records.push(record)
    await this.save()
    this.logger.info('created provider %s', this.label(record))
    return this.redact(record)
  }

  async update(id: string, patch: Partial<z.infer<typeof providerInput>>) {
    const record = this.get(id)
    const type = this.requireType(patch.type ?? record.type)
    if (patch.config) {
      // Masked values come back unchanged from the dashboard; keep the stored secret.
      const merged = { ...patch.config }
      for (const key of type.secrets ?? []) {
        if (isMasked(merged[key])) merged[key] = record.config[key]
      }
      record.config = this.validateConfig(type, merged)
    }
    if (patch.name !== undefined) record.name = patch.name
    if (patch.type !== undefined) record.type = patch.type
    if (patch.models !== undefined) record.models = patch.models
    if (patch.defaultModel !== undefined) record.defaultModel = patch.defaultModel
    if (patch.isDefault) this.markDefault(record)
    record.lastTest = undefined
    this.clients.delete(id)
    await this.save()
    this.logger.info('updated provider %s', this.label(record))
    return this.redact(record)
  }

  async delete(id: string) {
    const record = this.get(id)
    this.records = this.records.filter((item) => item !== record)
    if (record.isDefault && this.records[0]) this.markDefault(this.records[0])
    this.clients.delete(id)
    await this.save()
    this.logger.info('deleted provider %s', this.label(record))
    return { deleted: id }
  }

  private markDefault(record: ProviderRecord) {
    for (const item of this.records) item.isDefault = false
    record.isDefault = true
  }

  private label(record: ProviderRecord) {
    return `"${record.name}" (${record.type})`
  }

  async setDefault(id: string) {
    this.markDefault(this.get(id))
    await this.save()
    this.logger.info('default provider is now %s', this.label(this.get(id)))
    return this.redact(this.get(id))
  }

  client(record: ProviderRecord) {
    const type = this.typeStore.get(record.type)
    if (!type) throw new MushinError('unavailable', `Provider type "${record.type}" is not loaded; enable its plugin`)
    const key = JSON.stringify(record.config)
    const cached = this.clients.get(record.id)
    if (cached?.key === key) return cached.client
    const client = type.create(record.config)
    this.logger.debug('created a client for provider %s', this.label(record))
    this.clients.set(record.id, { key, client })
    return client
  }

  private resolve(options: { provider?: string; model?: string }) {
    const record = options.provider ? this.get(options.provider) : this.defaultProvider()
    if (!record) throw new MushinError('unavailable', 'No LLM provider is configured. Add one in Providers first.')
    const model = options.model ?? record.defaultModel ?? record.models[0]
    if (!model) throw new MushinError('invalid_input', `Provider "${record.name}" has no model set`)
    return { record, model, client: this.client(record) }
  }

  private result(record: ProviderRecord, model: string, start: number, response: Awaited<ReturnType<ProviderClient['chat']>>): LlmResult {
    const latencyMs = Date.now() - start
    const tokens = response.usage ? response.usage.inputTokens + response.usage.outputTokens : undefined
    this.home.emit('llm/called', {
      provider: record.id,
      providerName: record.name,
      model,
      ok: true,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      latencyMs,
    })
    return {
      ...response,
      provider: record.id,
      providerName: record.name,
      model,
      latencyMs,
      source: { kind: 'llm', provider: record.name, model, latencyMs, tokens },
    }
  }

  /** Runs one chat completion through the chosen (or default) provider. */
  async chat(options: LlmChatOptions): Promise<LlmResult> {
    const { record, model, client } = this.resolve(options)
    const start = Date.now()
    try {
      const response = await client.chat({ ...options, model } satisfies ChatRequest)
      return this.result(record, model, start, response)
    } catch (error) {
      this.logRequestError(record, model, error, start)
      throw error
    }
  }

  /** Streams text deltas, then yields the final result. Falls back to `chat` for clients without streaming. */
  async *stream(options: LlmChatOptions): AsyncGenerator<StreamEvent | { type: 'result'; result: LlmResult }> {
    const { record, model, client } = this.resolve(options)
    const start = Date.now()
    const request: ChatRequest = { ...options, model }
    try {
      if (!client.stream) {
        const response = await client.chat(request)
        if (response.text) yield { type: 'delta', text: response.text }
        yield { type: 'result', result: this.result(record, model, start, response) }
        return
      }
      for await (const event of client.stream(request)) {
        if (event.type === 'delta') yield event
        else yield { type: 'result', result: this.result(record, model, start, event.response) }
      }
    } catch (error) {
      this.logRequestError(record, model, error, start)
      throw error
    }
  }

  /** Whether a provider can embed text, for pickers. */
  canEmbed(id: string) {
    try {
      return !!this.client(this.get(id)).embed
    } catch {
      return false
    }
  }

  /** Embeds texts through a provider, `EMBED_BATCH` at a time; each batch is retried once. */
  async embed(options: LlmEmbedOptions): Promise<LlmEmbedResult> {
    const record = options.provider ? this.get(options.provider) : this.defaultProvider()
    if (!record) throw new MushinError('unavailable', 'No LLM provider is configured. Add one in Providers first.')
    const client = this.client(record)
    if (!client.embed) throw new MushinError('unavailable', `Provider "${record.name}" cannot embed text`)
    const vectors: number[][] = []
    let tokens = 0
    const start = Date.now()
    for (let index = 0; index < options.texts.length; index += EMBED_BATCH) {
      const input = options.texts.slice(index, index + EMBED_BATCH)
      let response
      try {
        response = await client.embed({ model: options.model, input, signal: options.signal }).catch((error) => {
          if (options.signal?.aborted) throw error
          return client.embed!({ model: options.model, input, signal: options.signal })
        })
      } catch (error) {
        this.logRequestError(record, options.model, error, start)
        throw error
      }
      if (response.vectors.length !== input.length) throw new MushinError('unavailable', `Provider "${record.name}" returned ${response.vectors.length} vectors for ${input.length} texts`)
      vectors.push(...response.vectors)
      tokens += response.usage?.inputTokens ?? 0
    }
    this.home.emit('llm/called', { provider: record.id, providerName: record.name, model: options.model, ok: true, inputTokens: tokens || undefined, latencyMs: Date.now() - start })
    return { vectors, provider: record.id, model: options.model, dimension: vectors[0]?.length ?? 0, ...(tokens ? { tokens } : {}) }
  }

  private logRequestError(record: ProviderRecord, model: string, error: unknown, start: number) {
    // A caller that gave up (timeout, user stop) is not the provider's fault.
    if (error instanceof Error && error.name === 'AbortError') return
    this.home.emit('llm/called', { provider: record.id, providerName: record.name, model, ok: false, latencyMs: Date.now() - start })
    this.logger.warn('request to %s (%s) failed: %s', this.label(record), model, error instanceof Error ? error.message : error)
  }

  async test(id: string): Promise<ProviderTest> {
    const record = this.get(id)
    const start = Date.now()
    let test: ProviderTest
    try {
      const { model, client } = this.resolve({ provider: id })
      await client.chat({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 256, signal: AbortSignal.timeout(60_000) })
      test = { ok: true, at: Date.now(), latencyMs: Date.now() - start, model }
    } catch (error) {
      test = { ok: false, at: Date.now(), error: error instanceof Error ? error.message : String(error) }
    }
    record.lastTest = test
    await this.save()
    if (test.ok) this.logger.info('provider %s passed its test in %d ms', this.label(record), test.latencyMs)
    else this.logger.warn('provider %s failed its test: %s', this.label(record), test.error)
    return test
  }

  async models(input: { provider?: string; type?: string; config?: Record<string, any> }) {
    let client: ProviderClient
    if (input.provider) {
      client = this.client(this.get(input.provider))
    } else if (input.type && input.config) {
      client = this.requireType(input.type).create(input.config)
    } else {
      throw new MushinError('invalid_input', 'Pass a provider id, or a type with its config')
    }
    if (!client.listModels) throw new MushinError('unavailable', 'This provider type cannot list models')
    return client.listModels(AbortSignal.timeout(15_000))
  }

  private *defineActions() {
    const actions = this.home.actions
    const idInput = z.object({ id: z.string().describe('Provider id from providers.list') })

    yield actions.define({
      name: 'providers.types',
      description: 'List provider types with their config JSON Schemas and presets (base URLs for DeepSeek, Moonshot, Qwen and others).',
      risk: 'read',
      input: z.object({}),
      handler: () => this.types(),
    })

    yield actions.define({
      name: 'providers.list',
      description: 'List configured LLM providers. Secrets are masked. Also reports whether the Agent is ready (a provider passed its test).',
      risk: 'read',
      input: z.object({}),
      handler: () => ({ providers: this.list(), ready: this.isReady() }),
    })

    yield actions.define({
      name: 'providers.create',
      description: 'Add an LLM provider. Run providers.test afterwards to check it works.',
      risk: 'write',
      input: providerInput,
      handler: (input) => this.create(input),
    })

    yield actions.define({
      name: 'providers.update',
      description: 'Change a provider. Masked secret values are kept as they are.',
      risk: 'write',
      input: idInput.extend(providerInput.partial().shape),
      handler: ({ id, ...patch }) => this.update(id, patch),
    })

    yield actions.define({
      name: 'providers.delete',
      description: 'Delete a provider.',
      risk: 'dangerous',
      input: idInput,
      handler: ({ id }) => this.delete(id),
    })

    yield actions.define({
      name: 'providers.test',
      description: 'Send a tiny request through a provider and report latency or the error.',
      risk: 'write',
      input: idInput,
      handler: ({ id }) => this.test(id),
    })

    yield actions.define({
      name: 'providers.setDefault',
      description: 'Make a provider the default for the Agent and bot plugins.',
      risk: 'write',
      input: idInput,
      handler: ({ id }) => this.setDefault(id),
    })

    yield actions.define({
      name: 'providers.embedChoices',
      description: 'Providers that can embed text (for knowledge bases), as ids and names.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.records.filter((record) => this.canEmbed(record.id)).map((record) => ({ value: record.id, label: record.name })),
    })

    yield actions.define({
      name: 'providers.models',
      description: 'Fetch the live model list from a saved provider, or from an unsaved type and config.',
      risk: 'read',
      input: z.object({
        provider: z.string().optional(),
        type: z.string().optional(),
        config: z.record(z.string(), z.any()).optional(),
      }),
      handler: (input) => this.models(input),
    })
  }
}

export default LlmService
