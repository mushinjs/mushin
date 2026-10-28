import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Context, type MessageRecord, MushinError, randomId, Service, z } from '@mushin/core'
import { type BotRole, roleAtLeast, type Session } from '@mushin/plugin-bots'
import type { Query } from '@mushin/plugin-database'
import type { FlowNode } from '@mushin/plugin-flows'
import type {} from '@mushin/plugin-providers'
import type {} from '@mushin/plugin-storage'
import { type Candidate, candidateText, LEARN_PROMPT, parseCandidates, transcript } from './learn'
import { searchNode } from './node'
import { type IndexedChunk, normalize, SearchIndex, type SearchHit } from './search'
import { chunkText, type DocFormat, extractText, formatOf, FORMATS, htmlToText } from './text'

export * from './learn'
export * from './search'
export * from './text'

declare module '@mushin/core' {
  interface Context {
    knowledge: Knowledge
  }

  interface Events {
    /** Bases, documents, chunks or candidates of a base changed. */
    'knowledge/changed'(change: { base: string }): void
    /** A document or a reindex is being processed. */
    'knowledge/progress'(progress: KnowledgeProgress): void
  }
}

declare module 'minato' {
  interface Tables {
    knowledge_base: KnowledgeBase
    knowledge_doc: KnowledgeDoc
    knowledge_chunk: ChunkRow
    knowledge_candidate: CandidateRow
  }
}

export interface LearnSettings {
  /** Pick out candidate knowledge from the chats of the base's bots. */
  enabled: boolean
  /** `group:<id>` or `private:<id>`; empty learns from every chat of the bots. */
  channels: string[]
  /** Learn once this many new messages arrived in a chat. */
  every: number
  /** Add candidates straight to the base instead of waiting for review. */
  autoAccept: boolean
  /** Most learning requests per day for this base. */
  dailyLimit: number
  /** Provider and model for learning; empty uses the bot's, then the default. */
  provider: string
  model: string
}

export interface KnowledgeBase {
  id: string
  name: string
  description: string
  /** Embedding provider and model; empty means keyword search only. */
  provider: string
  model: string
  /** Length of the vectors; 0 until the base is embedded with its current model. */
  dimension: number
  chunkSize: number
  chunkOverlap: number
  /** Defaults for searches that do not say. */
  topK: number
  minScore: number
  /** Bots whose admins may use `/记住`, `/收录` and `/忘记`, and whose chats it learns from. */
  bots: string[]
  commands: { enabled: boolean; role: BotRole }
  learn: LearnSettings
  createdAt: number
  updatedAt: number
}

/**
 * `file`: an uploaded file. `url`: a web page, fetched again when reparsed. `text`: pasted text.
 * `notes`: entries added one at a time (`/记住`, `/收录`, the dashboard). `learned`: accepted
 * candidates from chats.
 */
export type DocKind = 'file' | 'url' | 'text' | 'notes' | 'learned'
export type DocStatus = 'pending' | 'parsing' | 'embedding' | 'ready' | 'error'

export interface KnowledgeDoc {
  id: string
  base: string
  title: string
  kind: DocKind
  /** File name or URL. */
  source: string
  format: string
  status: DocStatus
  error: string
  /** SHA-256 of the content, so the same file is not added twice. */
  hash: string
  chars: number
  chunks: number
  createdAt: number
  updatedAt: number
}

interface ChunkRow {
  id: string
  base: string
  doc: string
  seq: number
  title: string
  text: string
  /** `Float32Array` bytes, normalized; empty when not embedded. */
  vector: ArrayBuffer
  /** Changed by hand; reparsing the document replaces it anyway. */
  edited: boolean
  /** For notes: who added it, where. */
  meta: Record<string, any>
  createdAt: number
  updatedAt: number
}

export type KnowledgeChunk = Omit<ChunkRow, 'vector'> & { embedded: boolean }

export type CandidateStatus = 'pending' | 'accepted' | 'rejected'

interface CandidateRow {
  id: number
  base: string
  bot: string
  channel: string
  question: string
  answer: string
  status: CandidateStatus
  /** The chunk an accepted candidate became. */
  chunk: string
  createdAt: number
  updatedAt: number
}

export type KnowledgeCandidate = CandidateRow

export interface KnowledgeProgress {
  base: string
  doc?: string
  /** `reindex` for a base being embedded again. */
  stage: DocStatus | 'reindex' | 'done'
  done: number
  total: number
}

/** A search hit with the base and document it came from. */
export interface KnowledgeHit extends SearchHit {
  base: string
  baseName: string
  docTitle: string
}

export interface KnowledgeSearch {
  hits: KnowledgeHit[]
  /** Searched by meaning too (at least one base has an embedding model that answered). */
  semantic: boolean
  /** Problems that made a base fall back to keywords, such as the embedding model failing. */
  warnings: string[]
}

/** A hit as a reply's provenance and a run's state keep it. */
export interface KnowledgeRef {
  base: string
  doc: string
  chunk: string
  title: string
}

const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TEXT_CHARS = 2_000_000
const NOTES_TITLE = '随手记'
const LEARNED_TITLE = '从对话学习'
const USAGE_KEY = 'knowledge/learn-usage'
const LEARN_STATE_KEY = 'knowledge/learn-state'
/** Fewest new messages worth a learning request. */
const LEARN_MIN_LINES = 5

const DEFAULT_LEARN: LearnSettings = { enabled: false, channels: [], every: 50, autoAccept: false, dailyLimit: 20, provider: '', model: '' }

const learnInput = z.object({
  enabled: z.boolean().optional(),
  channels: z.array(z.string().regex(/^(group|private):\S+$/)).optional().describe('"group:<id>" or "private:<user id>"; empty learns from every chat of the base\'s bots'),
  every: z.number().int().min(10).max(500).optional().describe('Learn after this many new messages in a chat'),
  autoAccept: z.boolean().optional().describe('Add what is learned straight away instead of waiting for review'),
  dailyLimit: z.number().int().min(1).max(500).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
})

const baseFields = {
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).optional(),
  provider: z.string().optional().describe('Embedding provider id (providers.embedChoices); empty for keyword search only'),
  model: z.string().optional().describe('Embedding model, e.g. text-embedding-3-small or bge-m3'),
  chunkSize: z.number().int().min(100).max(4000).optional().describe('Most characters per chunk (default 500)'),
  chunkOverlap: z.number().int().min(0).max(1000).optional().describe('Characters repeated from the previous chunk (default 50)'),
  topK: z.number().int().min(1).max(20).optional(),
  minScore: z.number().min(0).max(1).optional(),
  bots: z.array(z.string()).optional().describe('Bot ids whose admins may add knowledge from chat, and whose chats it learns from'),
  commands: z.object({ enabled: z.boolean().optional(), role: z.enum(['user', 'admin', 'master']).optional() }).optional(),
  learn: learnInput.optional(),
}

const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const vectorBytes = (vector: Float32Array | undefined) => (vector ? vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength) as ArrayBuffer : new ArrayBuffer(0))
const vectorOf = (bytes: ArrayBuffer | Uint8Array | undefined | null) => {
  if (!bytes || !bytes.byteLength) return undefined
  const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return new Float32Array(buffer as ArrayBuffer)
}
const hashOf = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The rows of a chunk as actions return them: no vector bytes. */
function publicChunk({ vector, ...row }: ChunkRow): KnowledgeChunk {
  return { ...row, embedded: !!vector?.byteLength }
}

/**
 * Knowledge bases: documents split into chunks, searched by keywords and (with an embedding
 * model) by meaning. Flows search them with a node, the Agent with `kb.search`, admins add to
 * them from chat, and they can learn candidate knowledge from chats for review.
 */
export class Knowledge extends Service {
  static inject = ['storage', 'actions', 'llm', 'bots', 'model', 'database']

  private home: Context
  private indexes = new Map<string, SearchIndex>()
  private queue: Promise<unknown> = Promise.resolve()
  private abort = new AbortController()
  /** Base id → `chat key` → messages since the last learning. */
  private counters = new Map<string, number>()
  private learning = new Set<string>()
  /** Chat key → when it was last learned from, so the same messages are not read twice. */
  private learnState: Record<string, number> = {}
  private usage: { day: string; counts: Record<string, number> } = { day: '', counts: {} }

  constructor(ctx: Context) {
    super(ctx, 'knowledge')
    this.home = ctx
  }

  private get logger() {
    return this.home.logger('knowledge')
  }

  private get db() {
    return this.home.database
  }

  async *[Service.init]() {
    const model = this.home.model
    model.extend('knowledge_base', {
      id: 'string', name: 'string', description: 'string', provider: 'string', model: 'string', dimension: 'unsigned',
      chunkSize: 'unsigned', chunkOverlap: 'unsigned', topK: 'unsigned', minScore: 'double',
      bots: 'json', commands: 'json', learn: 'json', createdAt: 'double', updatedAt: 'double',
    }, { primary: 'id' })
    model.extend('knowledge_doc', {
      id: 'string', base: 'string', title: 'string', kind: 'string', source: 'string', format: 'string', status: 'string', error: 'text',
      hash: 'string', chars: 'unsigned', chunks: 'unsigned', createdAt: 'double', updatedAt: 'double',
    }, { primary: 'id', indexes: [['base']] })
    model.extend('knowledge_chunk', {
      id: 'string', base: 'string', doc: 'string', seq: 'unsigned', title: 'string', text: 'text', vector: 'binary',
      edited: 'boolean', meta: 'json', createdAt: 'double', updatedAt: 'double',
    }, { primary: 'id', indexes: [['base'], ['doc', 'seq']] })
    model.extend('knowledge_candidate', {
      id: 'unsigned', base: 'string', bot: 'string', channel: 'string', question: 'text', answer: 'text', status: 'string',
      chunk: 'string', createdAt: 'double', updatedAt: 'double',
    }, { autoInc: true, indexes: [['base', 'status']] })

    this.learnState = (await this.home.storage.get<Record<string, number>>(LEARN_STATE_KEY)) ?? {}
    this.usage = (await this.home.storage.get<typeof this.usage>(USAGE_KEY)) ?? { day: '', counts: {} }
    yield this.home.effect(() => () => this.abort.abort(), 'knowledge jobs')

    // Documents a restart interrupted start over.
    const unfinished = await this.db.get('knowledge_doc', { status: ['pending', 'parsing', 'embedding'] } as Query<KnowledgeDoc>)
    for (const doc of unfinished) this.enqueue(() => this.process(doc.id))

    yield* this.defineActions()
    yield* this.defineCommands()
    yield this.home.on('bots/message', (record) => this.onMessage(record))
    this.home.inject(['flows'], (ctx) => {
      ctx.flows.defineNode(searchNode(this))
    })
    this.home.inject(['agent'], (ctx) => {
      ctx.agent.defineSkill({
        id: 'answer-from-knowledge',
        name: '根据知识库回答',
        description: '先在知识库里查资料，再根据查到的内容回答，并说明出处',
        whenToUse: '问题和已经整理进知识库的资料有关（群规、产品说明、常见问题等）',
        instructions: [
          '1. 用 kb.list 看有哪些知识库；用户指定了就只查那个。',
          '2. 用 kb.search 搜索问题，必要时换几种说法再搜。',
          '3. 只根据命中的片段回答，在句末标出片段编号和标题；没查到就直接说知识库里没有，不要编。',
          '4. 发现资料过时或互相矛盾时，指出来，并建议用 kb.chunks.update 修改。',
        ].join('\n'),
        tools: ['kb.list', 'kb.search', 'kb.chunks.list'],
        scenes: ['knowledge'],
      })
    })
    this.logger.info('knowledge bases are ready')
  }

  // ---- bases ----

  async list() {
    return this.db.get('knowledge_base', {}, { sort: { createdAt: 'asc' } })
  }

  async get(id: string) {
    const [base] = await this.db.get('knowledge_base', { id })
    if (!base) throw new MushinError('not_found', `Knowledge base "${id}" not found`)
    return base
  }

  /** Bases with their document, chunk and candidate counts, for the list page. */
  async summaries() {
    const bases = await this.list()
    const docs = await this.db.get('knowledge_doc', {})
    const pending = await this.db.get('knowledge_candidate', { status: 'pending' }, ['base'])
    return Promise.all(bases.map(async (base) => {
      const own = docs.filter((doc) => doc.base === base.id)
      const index = await this.index(base.id)
      return {
        ...base,
        docs: own.length,
        chunks: index.size,
        embedded: base.dimension ? index.embedded : 0,
        busy: own.some((doc) => doc.status !== 'ready' && doc.status !== 'error'),
        candidates: pending.filter((item) => item.base === base.id).length,
      }
    }))
  }

  /** Embeds a probe text to learn the model's vector length; fails with a readable error. */
  private async probe(provider: string, model: string) {
    try {
      const result = await this.home.llm.embed({ provider, model, texts: ['test'], signal: AbortSignal.timeout(30_000) })
      if (!result.dimension) throw new Error('the model returned an empty vector')
      return result.dimension
    } catch (error) {
      throw new MushinError('invalid_input', `The embedding model "${model}" did not work: ${errorText(error)}`)
    }
  }

  async create(input: z.infer<z.ZodObject<typeof baseFields>>) {
    const provider = input.provider ?? ''
    const model = provider ? input.model?.trim() ?? '' : ''
    if (provider && !model) throw new MushinError('invalid_input', 'Choose an embedding model, or no provider for keyword search only')
    const dimension = provider ? await this.probe(provider, model) : 0
    const now = Date.now()
    const base: KnowledgeBase = {
      id: randomId(6),
      name: input.name,
      description: input.description ?? '',
      provider,
      model,
      dimension,
      chunkSize: input.chunkSize ?? 500,
      chunkOverlap: input.chunkOverlap ?? 50,
      topK: input.topK ?? 5,
      minScore: input.minScore ?? 0.3,
      bots: input.bots ?? [],
      commands: { enabled: true, role: 'admin', ...input.commands },
      learn: { ...DEFAULT_LEARN, ...input.learn },
      createdAt: now,
      updatedAt: now,
    }
    await this.db.upsert('knowledge_base', [base])
    this.logger.info('created knowledge base "%s"%s', base.name, model ? ` with ${model}` : '')
    this.changed(base.id)
    return base
  }

  async update(id: string, patch: Partial<z.infer<z.ZodObject<typeof baseFields>>>) {
    const current = await this.get(id)
    const next: KnowledgeBase = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.chunkSize !== undefined ? { chunkSize: patch.chunkSize } : {}),
      ...(patch.chunkOverlap !== undefined ? { chunkOverlap: patch.chunkOverlap } : {}),
      ...(patch.topK !== undefined ? { topK: patch.topK } : {}),
      ...(patch.minScore !== undefined ? { minScore: patch.minScore } : {}),
      ...(patch.bots !== undefined ? { bots: patch.bots } : {}),
      commands: { ...current.commands, ...patch.commands },
      learn: { ...DEFAULT_LEARN, ...current.learn, ...patch.learn },
      updatedAt: Date.now(),
    }
    const provider = patch.provider ?? current.provider
    const model = provider ? (patch.model ?? current.model).trim() : ''
    const modelChanged = provider !== current.provider || model !== current.model
    if (modelChanged) {
      if (provider && !model) throw new MushinError('invalid_input', 'Choose an embedding model, or no provider for keyword search only')
      next.provider = provider
      next.model = model
      // Old vectors do not fit the new model: searches use keywords until the base is embedded again.
      next.dimension = provider ? await this.probe(provider, model) : 0
    }
    await this.db.upsert('knowledge_base', [next])
    this.indexes.delete(id)
    this.changed(id)
    if (modelChanged) {
      this.logger.info('knowledge base "%s" now uses %s', next.name, model || 'keywords only')
      if (provider) void this.reindex(id)
      else await this.db.set('knowledge_chunk', { base: id }, { vector: new ArrayBuffer(0) })
    }
    return next
  }

  async remove(id: string) {
    const base = await this.get(id)
    await this.db.remove('knowledge_chunk', { base: id })
    await this.db.remove('knowledge_doc', { base: id })
    await this.db.remove('knowledge_candidate', { base: id })
    await this.db.remove('knowledge_base', { id })
    await rm(this.fileDir(id), { recursive: true, force: true })
    this.indexes.delete(id)
    this.logger.info('deleted knowledge base "%s"', base.name)
    this.changed(id)
    return { ok: true }
  }

  private changed(base: string) {
    this.home.emit('knowledge/changed', { base })
  }

  private progress(progress: KnowledgeProgress) {
    this.home.emit('knowledge/progress', progress)
  }

  // ---- documents ----

  private fileDir(base: string) {
    return join(this.home.storage.dir, 'knowledge', base)
  }

  private filePath(doc: Pick<KnowledgeDoc, 'base' | 'id' | 'format'>) {
    return join(this.fileDir(doc.base), `${doc.id}.${doc.format}`)
  }

  async docs(base: string) {
    await this.get(base)
    return this.db.get('knowledge_doc', { base }, { sort: { createdAt: 'asc' } })
  }

  async doc(id: string) {
    const [doc] = await this.db.get('knowledge_doc', { id })
    if (!doc) throw new MushinError('not_found', `Document "${id}" not found`)
    return doc
  }

  /**
   * Adds a document: a file (`data` in base64 with its `name`), pasted `text`, or a `url` to fetch.
   * It is parsed, split and embedded in the background; `knowledge/progress` reports how it goes.
   */
  async addDoc(input: { base: string; name?: string; text?: string; data?: string; url?: string }) {
    const base = await this.get(input.base)
    let kind: DocKind
    let format: DocFormat
    let bytes: Uint8Array
    let title = input.name?.trim() ?? ''
    let source = ''
    if (input.url) {
      const url = new URL(input.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new MushinError('invalid_input', 'Only http and https links can be added')
      kind = 'url'
      source = url.href
      const fetched = await this.fetchPage(url.href)
      format = fetched.format
      bytes = fetched.bytes
      title ||= fetched.title || url.hostname + url.pathname
    } else if (input.data !== undefined) {
      if (!title) throw new MushinError('invalid_input', 'Give the file\'s name')
      const detected = formatOf(title)
      if (!detected) throw new MushinError('invalid_input', `Cannot read "${title}"; supported: ${FORMATS.join(', ')}`)
      kind = 'file'
      format = detected
      source = title
      bytes = Buffer.from(input.data, 'base64')
      title = title.replace(/\.[^.]+$/, '')
    } else if (input.text !== undefined) {
      if (!input.text.trim()) throw new MushinError('invalid_input', 'The text is empty')
      kind = 'text'
      format = 'md'
      bytes = new TextEncoder().encode(input.text)
      title ||= input.text.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 40)
    } else {
      throw new MushinError('invalid_input', 'Give a file (name and data), text, or a url')
    }
    if (bytes.byteLength > MAX_FILE_BYTES) throw new MushinError('invalid_input', `Files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`)
    const hash = hashOf(bytes)
    const [same] = await this.db.get('knowledge_doc', { base: base.id, hash })
    if (same) throw new MushinError('conflict', `"${same.title}" in this base has the same content`)
    const now = Date.now()
    const doc: KnowledgeDoc = {
      id: randomId(6), base: base.id, title, kind, source, format, status: 'pending', error: '', hash, chars: 0, chunks: 0, createdAt: now, updatedAt: now,
    }
    await mkdir(this.fileDir(base.id), { recursive: true })
    await writeFile(this.filePath(doc), bytes)
    await this.db.upsert('knowledge_doc', [doc])
    this.logger.info('added "%s" to knowledge base "%s"', doc.title, base.name)
    this.changed(base.id)
    this.enqueue(() => this.process(doc.id))
    return doc
  }

  private async fetchPage(url: string) {
    let response: Response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Mushin.js knowledge base' } })
    } catch (error) {
      throw new MushinError('unavailable', `Could not fetch ${url}: ${errorText(error)}`)
    }
    if (!response.ok) throw new MushinError('unavailable', `${url} answered HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const type = response.headers.get('content-type') ?? ''
    const format: DocFormat = type.includes('pdf') ? 'pdf' : type.includes('html') || !type ? 'html' : formatOf(new URL(url).pathname) ?? 'txt'
    const title = format === 'html' ? htmlToText(new TextDecoder().decode(bytes)).title : undefined
    return { bytes, format, title }
  }

  async removeDoc(id: string) {
    const doc = await this.doc(id)
    await this.db.remove('knowledge_chunk', { doc: id })
    await this.db.remove('knowledge_doc', { id })
    await rm(this.filePath(doc), { force: true })
    this.indexes.delete(doc.base)
    this.changed(doc.base)
    return { ok: true }
  }

  /** Parses a document again from its file (a web page is fetched again); edits to its chunks are lost. */
  async reparse(id: string) {
    const doc = await this.doc(id)
    if (doc.kind === 'notes' || doc.kind === 'learned') throw new MushinError('invalid_input', 'This document is made of single entries and has nothing to parse')
    if (doc.kind === 'url') {
      const fetched = await this.fetchPage(doc.source)
      await writeFile(this.filePath({ ...doc, format: fetched.format }), fetched.bytes)
      doc.format = fetched.format
      doc.hash = hashOf(fetched.bytes)
    }
    await this.db.upsert('knowledge_doc', [{ ...doc, status: 'pending', error: '', updatedAt: Date.now() }])
    this.changed(doc.base)
    this.enqueue(() => this.process(id))
    return { ok: true }
  }

  private enqueue(task: () => Promise<unknown>) {
    this.queue = this.queue.catch(() => {}).then(() => (this.abort.signal.aborted ? undefined : task()))
    return this.queue
  }

  private async setStatus(doc: KnowledgeDoc, status: DocStatus, extra: Partial<KnowledgeDoc> = {}) {
    Object.assign(doc, { status, updatedAt: Date.now(), ...extra })
    await this.db.upsert('knowledge_doc', [doc])
    this.changed(doc.base)
  }

  /** Embeds texts with a base's model, `onBatch` after each batch; nothing for keyword-only bases. */
  private async embedTexts(base: KnowledgeBase, texts: string[], onBatch?: (done: number) => void) {
    if (!base.provider || !base.model || !texts.length) return undefined
    const vectors: Float32Array[] = []
    const BATCH = 32
    for (let index = 0; index < texts.length; index += BATCH) {
      const result = await this.home.llm.embed({ provider: base.provider, model: base.model, texts: texts.slice(index, index + BATCH), signal: this.abort.signal })
      vectors.push(...result.vectors.map(normalize))
      onBatch?.(Math.min(index + BATCH, texts.length))
    }
    return vectors
  }

  /** What a chunk's embedding reads: its title and text. */
  private embedText(chunk: { title: string; text: string }) {
    return chunk.title ? `${chunk.title}\n${chunk.text}` : chunk.text
  }

  private async process(id: string) {
    const [doc] = await this.db.get('knowledge_doc', { id })
    if (!doc) return
    let base: KnowledgeBase
    try {
      base = await this.get(doc.base)
    } catch {
      return
    }
    try {
      await this.setStatus(doc, 'parsing')
      this.progress({ base: base.id, doc: id, stage: 'parsing', done: 0, total: 0 })
      const bytes = new Uint8Array(await readFile(this.filePath(doc)))
      const extracted = await extractText(doc.format as DocFormat, bytes)
      const text = extracted.text.slice(0, MAX_TEXT_CHARS)
      const pieces = chunkText(text, { size: base.chunkSize, overlap: base.chunkOverlap }, doc.title)
      if (!pieces.length) throw new MushinError('invalid_input', 'No text found in this document')
      await this.setStatus(doc, 'embedding', { chars: text.length })
      this.progress({ base: base.id, doc: id, stage: 'embedding', done: 0, total: pieces.length })
      const vectors = await this.embedTexts(base, pieces.map((piece) => this.embedText(piece)), (done) => {
        this.progress({ base: base.id, doc: id, stage: 'embedding', done, total: pieces.length })
      })
      const now = Date.now()
      const rows: ChunkRow[] = pieces.map((piece, seq) => ({
        id: randomId(8), base: base.id, doc: id, seq, title: piece.title, text: piece.text, vector: vectorBytes(vectors?.[seq]),
        edited: false, meta: {}, createdAt: now, updatedAt: now,
      }))
      await this.db.remove('knowledge_chunk', { doc: id })
      await this.db.upsert('knowledge_chunk', rows)
      this.indexes.delete(base.id)
      await this.setStatus(doc, 'ready', { chunks: rows.length, error: '' })
      this.progress({ base: base.id, doc: id, stage: 'done', done: rows.length, total: rows.length })
      this.logger.info('"%s" is ready: %d chunk(s)', doc.title, rows.length)
    } catch (error) {
      if (this.abort.signal.aborted) return
      this.logger.warn('reading "%s" failed: %s', doc.title, errorText(error))
      await this.setStatus(doc, 'error', { error: errorText(error) }).catch(() => {})
      this.progress({ base: base.id, doc: id, stage: 'error', done: 0, total: 0 })
    }
  }

  /** Embeds every chunk of a base again with its current model, e.g. after the model changed. */
  async reindex(id: string) {
    const base = await this.get(id)
    if (!base.provider) throw new MushinError('invalid_input', 'This base has no embedding model; it searches by keywords only')
    return this.enqueue(async () => {
      const rows = await this.db.get('knowledge_chunk', { base: id })
      this.progress({ base: id, stage: 'reindex', done: 0, total: rows.length })
      try {
        const vectors = await this.embedTexts(base, rows.map((row) => this.embedText(row)), (done) => {
          this.progress({ base: id, stage: 'reindex', done, total: rows.length })
        }) ?? []
        await this.db.upsert('knowledge_chunk', rows.map((row, index) => ({ ...row, vector: vectorBytes(vectors[index]) })))
        this.logger.info('embedded %d chunk(s) of "%s" again', rows.length, base.name)
      } catch (error) {
        if (!this.abort.signal.aborted) this.logger.warn('embedding "%s" again failed: %s', base.name, errorText(error))
      }
      this.indexes.delete(id)
      this.progress({ base: id, stage: 'done', done: rows.length, total: rows.length })
      this.changed(id)
    })
  }

  // ---- chunks ----

  async chunks(input: { base: string; doc?: string; offset?: number; limit?: number; query?: string }) {
    await this.get(input.base)
    const rows = await this.db.get('knowledge_chunk', input.doc ? { base: input.base, doc: input.doc } : { base: input.base }, { sort: { doc: 'asc', seq: 'asc' } })
    const query = input.query?.trim().toLowerCase()
    const matched = query ? rows.filter((row) => row.text.toLowerCase().includes(query) || row.title.toLowerCase().includes(query)) : rows
    const offset = input.offset ?? 0
    return { total: matched.length, chunks: matched.slice(offset, offset + (input.limit ?? 50)).map(publicChunk) }
  }

  private async chunkRow(id: string) {
    const [row] = await this.db.get('knowledge_chunk', { id })
    if (!row) throw new MushinError('not_found', `Chunk "${id}" not found`)
    return row
  }

  async updateChunk(id: string, patch: { title?: string; text?: string }) {
    const row = await this.chunkRow(id)
    const base = await this.get(row.base)
    const next = { ...row, ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.text !== undefined ? { text: patch.text } : {}), edited: true, updatedAt: Date.now() }
    if (!next.text.trim()) throw new MushinError('invalid_input', 'A chunk needs text; remove it instead')
    const [vector] = await this.embedTexts(base, [this.embedText(next)]) ?? []
    next.vector = vectorBytes(vector)
    await this.db.upsert('knowledge_chunk', [next])
    this.indexes.delete(row.base)
    this.changed(row.base)
    return publicChunk(next)
  }

  async removeChunk(id: string) {
    const row = await this.chunkRow(id)
    await this.db.remove('knowledge_chunk', { id })
    await this.recount(row.doc)
    this.indexes.delete(row.base)
    this.changed(row.base)
    return { ok: true }
  }

  /** Joins a chunk with the one after it in the same document. */
  async mergeChunk(id: string) {
    const row = await this.chunkRow(id)
    const [after] = await this.db.get('knowledge_chunk', { doc: row.doc, seq: { $gt: row.seq } }, { sort: { seq: 'asc' }, limit: 1 })
    if (!after) throw new MushinError('invalid_input', 'This is the last chunk of its document')
    await this.db.remove('knowledge_chunk', { id: after.id })
    const merged = await this.updateChunk(id, { text: `${row.text}\n\n${after.text}` })
    await this.recount(row.doc)
    return merged
  }

  private async recount(docId: string) {
    const [doc] = await this.db.get('knowledge_doc', { id: docId })
    if (!doc) return
    const count = (await this.db.get('knowledge_chunk', { doc: docId }, ['id'])).length
    await this.db.upsert('knowledge_doc', [{ ...doc, chunks: count, updatedAt: Date.now() }])
  }

  /** The document of single entries of a kind, made the first time one is added. */
  private async entriesDoc(base: KnowledgeBase, kind: 'notes' | 'learned') {
    const [found] = await this.db.get('knowledge_doc', { base: base.id, kind })
    if (found) return found
    const now = Date.now()
    const doc: KnowledgeDoc = {
      id: randomId(6), base: base.id, title: kind === 'notes' ? NOTES_TITLE : LEARNED_TITLE, kind, source: '', format: 'md',
      status: 'ready', error: '', hash: `${kind}:${base.id}`, chars: 0, chunks: 0, createdAt: now, updatedAt: now,
    }
    await this.db.upsert('knowledge_doc', [doc])
    return doc
  }

  /** Adds one entry, such as a `/记住` note or an accepted candidate, as a chunk of its own. */
  async addEntry(baseId: string, entry: { text: string; title?: string; kind?: 'notes' | 'learned'; meta?: Record<string, any> }) {
    const base = await this.get(baseId)
    const text = entry.text.trim()
    if (!text) throw new MushinError('invalid_input', 'The entry is empty')
    const doc = await this.entriesDoc(base, entry.kind ?? 'notes')
    const [last] = await this.db.get('knowledge_chunk', { doc: doc.id }, { sort: { seq: 'desc' }, limit: 1 })
    const title = entry.title?.trim() ?? ''
    const [vector] = await this.embedTexts(base, [this.embedText({ title, text })]) ?? []
    const now = Date.now()
    const row: ChunkRow = {
      id: randomId(8), base: base.id, doc: doc.id, seq: (last?.seq ?? -1) + 1, title, text, vector: vectorBytes(vector),
      edited: false, meta: entry.meta ?? {}, createdAt: now, updatedAt: now,
    }
    await this.db.upsert('knowledge_chunk', [row])
    await this.recount(doc.id)
    this.indexes.delete(base.id)
    this.changed(base.id)
    return publicChunk(row)
  }

  /** Removes notes that contain the text; returns how many. */
  async forget(baseId: string, text: string) {
    const wanted = text.trim().toLowerCase()
    if (!wanted) return 0
    const docs = await this.db.get('knowledge_doc', { base: baseId, kind: 'notes' })
    let removed = 0
    for (const doc of docs) {
      const rows = await this.db.get('knowledge_chunk', { doc: doc.id })
      const matching = rows.filter((row) => row.text.toLowerCase().includes(wanted))
      if (!matching.length) continue
      await this.db.remove('knowledge_chunk', { id: matching.map((row) => row.id) })
      await this.recount(doc.id)
      removed += matching.length
    }
    if (removed) {
      this.indexes.delete(baseId)
      this.changed(baseId)
    }
    return removed
  }

  // ---- search ----

  private async index(base: string) {
    let index = this.indexes.get(base)
    if (index) return index
    const [record] = await this.db.get('knowledge_base', { id: base })
    const rows = await this.db.get('knowledge_chunk', { base })
    index = new SearchIndex(rows.map((row): IndexedChunk => {
      const vector = vectorOf(row.vector)
      return { id: row.id, doc: row.doc, title: row.title, text: row.text, ...(vector && record?.dimension === vector.length ? { vector } : {}) }
    }))
    this.indexes.set(base, index)
    return index
  }

  /**
   * Searches bases (every one when none are given) by keywords and, where the base has an
   * embedding model, by meaning. A failing embedding model falls back to keywords with a warning.
   */
  async search(input: { bases?: string[]; query: string; topK?: number; minScore?: number; signal?: AbortSignal }): Promise<KnowledgeSearch> {
    const all = await this.list()
    const bases = input.bases?.length ? input.bases.map((id) => {
      const found = all.find((base) => base.id === id || base.name === id)
      if (!found) throw new MushinError('not_found', `Knowledge base "${id}" not found`)
      return found
    }) : all
    const query = input.query.trim()
    const warnings: string[] = []
    if (!query || !bases.length) return { hits: [], semantic: false, warnings }
    const vectors = new Map<string, Float32Array | undefined>()
    let semantic = false
    const hits: KnowledgeHit[] = []
    const docTitles = new Map<string, string>()
    for (const base of bases) {
      let vector: Float32Array | undefined
      if (base.provider && base.model && base.dimension) {
        const key = `${base.provider}|${base.model}`
        if (!vectors.has(key)) {
          try {
            const result = await this.home.llm.embed({ provider: base.provider, model: base.model, texts: [query], signal: input.signal ?? AbortSignal.timeout(20_000) })
            vectors.set(key, normalize(result.vectors[0]))
          } catch (error) {
            if (input.signal?.aborted) throw error
            vectors.set(key, undefined)
            warnings.push(`${base.name}: the embedding model failed (${errorText(error)}); searched by keywords only`)
          }
        }
        vector = vectors.get(key)
        if (vector) semantic = true
      }
      const index = await this.index(base.id)
      for (const hit of index.search(query, vector, { topK: input.topK ?? base.topK, minScore: input.minScore ?? base.minScore })) {
        if (!docTitles.has(hit.doc)) docTitles.set(hit.doc, (await this.db.get('knowledge_doc', { id: hit.doc }, ['title']))[0]?.title ?? '')
        hits.push({ ...hit, base: base.id, baseName: base.name, docTitle: docTitles.get(hit.doc)! })
      }
    }
    const topK = input.topK ?? Math.max(...bases.map((base) => base.topK))
    hits.sort((a, b) => b.fused - a.fused || b.score - a.score)
    return { hits: hits.slice(0, topK), semantic, warnings }
  }

  /** Chunks and links between similar ones, for the similarity map. */
  async graph(input: { base: string; neighbors?: number; minSimilarity?: number; limit?: number }) {
    const base = await this.get(input.base)
    const index = await this.index(base.id)
    const { nodes, edges, byVector } = index.links(input)
    const docs = new Map((await this.db.get('knowledge_doc', { base: base.id })).map((doc) => [doc.id, doc.title]))
    return {
      byVector,
      total: index.size,
      nodes: nodes.map((chunk) => ({ id: chunk.id, doc: chunk.doc, docTitle: docs.get(chunk.doc) ?? '', title: chunk.title, text: chunk.text.slice(0, 300) })),
      edges,
    }
  }

  // ---- flows ----

  /** Flows that ask an LLM, for "use in a flow", with whether they already search this base. */
  flowChoices(base?: string) {
    const flows = this.home.get('flows')
    if (!flows) return []
    return flows.list().flatMap((summary: { id: string }) => {
      const doc = flows.get(summary.id)
      if (!doc.nodes.some((node) => node.type === 'ai.chat')) return []
      const search = doc.nodes.find((node) => node.type === 'kb.search')
      return [{
        id: doc.id,
        name: doc.name,
        bots: doc.bots,
        llmChat: doc.source?.kind === 'plugin' && doc.source.plugin === '@mushin/bot-plugin-llm-chat',
        uses: !!search && (!base || ((search.config.bases as string[] | undefined) ?? []).includes(base)),
      }]
    })
  }

  /**
   * Puts a knowledge search in front of a flow's first "Ask the LLM" node and passes its passages
   * to it; a flow that already has a search node gets these bases added to it.
   */
  async useInFlow(flowId: string, bases: string[]) {
    const flows = this.home.get('flows')
    if (!flows) throw new MushinError('unavailable', 'Flows are not running')
    for (const id of bases) await this.get(id)
    const doc = flows.get(flowId)
    const existing = doc.nodes.find((node) => node.type === 'kb.search')
    if (existing) {
      const merged = [...new Set([...((existing.config.bases as string[] | undefined) ?? []), ...bases])]
      const nodes = doc.nodes.map((node) => (node === existing ? { ...node, config: { ...node.config, bases: merged } } : node))
      await flows.update(flowId, { nodes })
      return { flow: flowId, node: existing.id, added: false }
    }
    const chat = doc.nodes.find((node) => node.type === 'ai.chat')
    if (!chat) throw new MushinError('invalid_input', `"${doc.name}" has no "Ask the LLM" node`)
    let id = 'kb'
    for (let n = 2; doc.nodes.some((node) => node.id === id); n++) id = `kb${n}`
    const shift = 280
    const search: FlowNode = {
      id,
      type: 'kb.search',
      label: '知识库检索',
      position: { ...chat.position },
      config: { bases, topK: 3, minScore: 0.3 },
    }
    const nodes = [
      ...doc.nodes.map((node) => {
        const moved = node.position.x >= chat.position.x ? { ...node, position: { x: node.position.x + shift, y: node.position.y } } : node
        return node === chat ? { ...moved, inputs: { ...chat.inputs, knowledge: `{{${id}.context}}` } } : moved
      }),
      search,
    ]
    const edges = [
      ...doc.edges.map((edge) => (edge.target === chat.id && edge.targetHandle === 'exec' ? { ...edge, target: id } : edge)),
      { source: id, sourceHandle: 'exec:next', target: chat.id, targetHandle: 'exec' },
      { source: id, sourceHandle: 'exec:empty', target: chat.id, targetHandle: 'exec' },
    ]
    await flows.update(flowId, { nodes, edges })
    this.logger.info('flow "%s" now searches knowledge before asking the LLM', doc.name)
    return { flow: flowId, node: id, added: true }
  }

  // ---- chat commands ----

  /** Bases a bot may add to from chat, oldest first. */
  private async basesFor(botId: string) {
    return (await this.list()).filter((base) => base.commands.enabled && base.bots.includes(botId))
  }

  private *defineCommands() {
    const bots = this.home.bots
    const hasBases = new Set<string>()
    const refresh = async () => {
      hasBases.clear()
      for (const base of await this.list()) if (base.commands.enabled) for (const bot of base.bots) hasBases.add(bot)
    }
    void refresh()
    yield this.home.on('knowledge/changed', () => void refresh())
    const only = { bots: (botId: string) => hasBases.has(botId) }

    yield bots.defineCommand({ name: '记住', aliases: ['remember'], description: '把一句话记进知识库', usage: '<内容...>' }, async (session) => {
      const base = await this.allowed(session)
      if (!base) return
      const text = session.command?.rest.trim() ?? ''
      if (!text) return session.send('用法：/记住 要记住的内容')
      await this.addEntry(base.id, { text, meta: this.metaOf(session) })
      await session.send(`已记进知识库「${base.name}」`)
    }, only)

    yield bots.defineCommand({ name: '收录', aliases: ['collect'], description: '回复一条消息，把它收进知识库' }, async (session) => {
      const base = await this.allowed(session)
      if (!base) return
      const quoted = session.segments.find((segment) => segment.type === 'reply')?.data?.id
      if (!quoted) return session.send('请回复要收录的那条消息，再发 /收录')
      const messages = await bots.messages(session.bot.id, { channel: session.channel.id, limit: 500 })
      const message = messages.find((record) => record.messageId === String(quoted))
      const text = message ? message.segments.filter((segment) => segment.type === 'text').map((segment) => segment.data.text).join('').trim() : ''
      if (!text) return session.send('没找到那条消息的文字内容（可能太早，或者不是文字消息）')
      await this.addEntry(base.id, { text, meta: { ...this.metaOf(session), from: message!.user.id, fromName: message!.user.name ?? '' } })
      await session.send(`已收录到知识库「${base.name}」`)
    }, only)

    yield bots.defineCommand({ name: '忘记', aliases: ['forget'], description: '从知识库删除记住的内容', usage: '<内容...>' }, async (session) => {
      const base = await this.allowed(session)
      if (!base) return
      const text = session.command?.rest.trim() ?? ''
      if (!text) return session.send('用法：/忘记 要删除的内容（会删除包含这段文字的记录）')
      const removed = await this.forget(base.id, text)
      await session.send(removed ? `已从知识库「${base.name}」删除 ${removed} 条` : `知识库「${base.name}」里没有用 /记住 或 /收录 记下的、包含“${text}”的内容`)
    }, only)
  }

  private metaOf(session: Session) {
    return { bot: session.bot.id, channel: `${session.channel.type}:${session.channel.id}`, user: session.user.id, userName: session.user.name ?? '' }
  }

  /** The base a chat command writes to, after checking the sender may use it; tells them when not. */
  private async allowed(session: Session) {
    const [base] = await this.basesFor(session.bot.id)
    if (!base) return
    if (!roleAtLeast(session.role() ?? 'user', base.commands.role)) {
      await session.send(base.commands.role === 'master' ? '只有主人可以修改知识库' : '需要管理员及以上才能修改知识库')
      return
    }
    return base
  }

  // ---- learning ----

  private onMessage(record: MessageRecord) {
    if (!record.segments.some((segment) => segment.type === 'text')) return
    void this.list().then((bases) => {
      const chat = `${record.channel.type}:${record.channel.id}`
      for (const base of bases) {
        const learn = { ...DEFAULT_LEARN, ...base.learn }
        if (!learn.enabled || !base.bots.includes(record.botId)) continue
        if (learn.channels.length && !learn.channels.includes(chat)) continue
        const key = `${base.id}|${record.botId}|${chat}`
        const count = (this.counters.get(key) ?? 0) + 1
        if (count < learn.every) {
          this.counters.set(key, count)
          continue
        }
        this.counters.delete(key)
        void this.learn(base.id, record.botId, chat).catch((error) => this.logger.warn('learning from %s failed: %s', chat, errorText(error)))
      }
    }, () => {})
  }

  private async useQuota(base: KnowledgeBase) {
    const today = localDay()
    if (this.usage.day !== today) this.usage = { day: today, counts: {} }
    const used = this.usage.counts[base.id] ?? 0
    if (used >= base.learn.dailyLimit) return false
    this.usage.counts[base.id] = used + 1
    await this.home.storage.set(USAGE_KEY, this.usage)
    return true
  }

  /**
   * Reads a chat's messages since it was last learned from and asks the LLM for knowledge worth
   * keeping. What it finds waits for review, or is added straight away with auto-accept.
   */
  async learn(baseId: string, botId: string, chat: string): Promise<{ candidates: KnowledgeCandidate[]; skipped?: string }> {
    const base = await this.get(baseId)
    const learn = { ...DEFAULT_LEARN, ...base.learn }
    const key = `${baseId}|${botId}|${chat}`
    if (this.learning.has(key)) return { candidates: [], skipped: 'already learning from this chat' }
    const bot = this.home.bots.get(botId)
    const [type, ...rest] = chat.split(':')
    const channelId = rest.join(':')
    const since = this.learnState[key] ?? 0
    const lines = (await this.home.bots.messages(botId, { channel: channelId, limit: Math.max(learn.every, 50) }))
      .filter((record) => record.channel.type === type && record.timestamp > since)
    const text = lines.map((record) => ({
      direction: record.direction,
      user: record.user,
      text: record.segments.filter((segment) => segment.type === 'text').map((segment) => segment.data.text).join(''),
    }))
    if (text.filter((line) => line.text.trim()).length < LEARN_MIN_LINES) return { candidates: [], skipped: 'not enough new messages' }
    if (!(await this.useQuota(base))) return { candidates: [], skipped: 'the daily learning limit is used up' }
    this.learning.add(key)
    try {
      const result = await this.home.llm.chat({
        provider: learn.provider || bot.provider || undefined,
        model: learn.model || undefined,
        maxTokens: 2000,
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(90_000)]),
        messages: [
          { role: 'system', content: LEARN_PROMPT },
          { role: 'user', content: transcript(text, bot.name) },
        ],
      })
      this.learnState[key] = Math.max(...lines.map((record) => record.timestamp))
      await this.home.storage.set(LEARN_STATE_KEY, this.learnState)
      const found = await this.newCandidates(base, parseCandidates(result.text))
      const now = Date.now()
      const created: KnowledgeCandidate[] = []
      for (const candidate of found) {
        const row = await this.db.create('knowledge_candidate', {
          base: baseId, bot: botId, channel: chat, question: candidate.question, answer: candidate.answer, status: 'pending', chunk: '', createdAt: now, updatedAt: now,
        })
        created.push(learn.autoAccept ? await this.accept(row.id) : row)
      }
      this.logger.info('learned %d item(s) for "%s" from %s', created.length, base.name, chat)
      if (created.length) this.changed(baseId)
      return { candidates: created }
    } finally {
      this.learning.delete(key)
    }
  }

  /** Leaves out candidates already waiting for review or already known to the base. */
  private async newCandidates(base: KnowledgeBase, found: Candidate[]) {
    const pending = new Set((await this.db.get('knowledge_candidate', { base: base.id, status: 'pending' }, ['question'])).map((row) => row.question))
    const fresh: Candidate[] = []
    for (const candidate of found) {
      if (pending.has(candidate.question)) continue
      const { hits } = await this.search({ bases: [base.id], query: candidate.question, topK: 1, minScore: 0.9 }).catch(() => ({ hits: [] }))
      if (hits.length) continue
      fresh.push(candidate)
    }
    return fresh
  }

  async candidates(base: string, status?: CandidateStatus) {
    await this.get(base)
    return this.db.get('knowledge_candidate', status ? { base, status } : { base }, { sort: { createdAt: 'desc' } })
  }

  private async candidate(id: number) {
    const [row] = await this.db.get('knowledge_candidate', { id })
    if (!row) throw new MushinError('not_found', `Candidate ${id} not found`)
    return row
  }

  /** Adds a candidate (as edited) to the base's "learned from chats" document. */
  async accept(id: number, patch: { question?: string; answer?: string } = {}) {
    const row = await this.candidate(id)
    if (row.status === 'accepted') return row
    const question = patch.question?.trim() || row.question
    const answer = patch.answer?.trim() || row.answer
    const chunk = await this.addEntry(row.base, { kind: 'learned', title: question, text: candidateText({ question, answer }), meta: { bot: row.bot, channel: row.channel, candidate: row.id } })
    const next: CandidateRow = { ...row, question, answer, status: 'accepted', chunk: chunk.id, updatedAt: Date.now() }
    await this.db.upsert('knowledge_candidate', [next])
    this.changed(row.base)
    return next
  }

  async reject(id: number) {
    const row = await this.candidate(id)
    const next: CandidateRow = { ...row, status: 'rejected', updatedAt: Date.now() }
    await this.db.upsert('knowledge_candidate', [next])
    this.changed(row.base)
    return next
  }

  // ---- actions ----

  private *defineActions() {
    const actions = this.home.actions
    const baseId = z.object({ base: z.string().describe('Knowledge base id from kb.list') })

    yield actions.define({
      name: 'kb.list',
      description: 'List knowledge bases: name, embedding model (none means keyword search only), document, chunk and pending candidate counts, linked bots and learning settings.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.summaries(),
    })

    yield actions.define({
      name: 'kb.choices',
      description: 'Knowledge base ids and names, for pickers.',
      risk: 'read',
      input: z.object({}),
      handler: async () => (await this.list()).map((base) => ({ value: base.id, label: base.name })),
    })

    yield actions.define({
      name: 'kb.create',
      description: 'Create a knowledge base. With an embedding provider and model (providers.embedChoices) it searches by meaning as well as keywords; the model is tried once. Link bots to let their admins add knowledge from chat (/记住, /收录, /忘记) and to learn from their chats.',
      risk: 'write',
      input: z.object(baseFields),
      handler: (input) => this.create(input),
    })

    yield actions.define({
      name: 'kb.update',
      description: 'Change a knowledge base. Changing the embedding model embeds every chunk again in the background. Lists given replace the old ones.',
      risk: 'write',
      input: z.object({ id: z.string() }).extend(z.object(baseFields).partial().shape),
      handler: ({ id, ...patch }) => this.update(id, patch),
    })

    yield actions.define({
      name: 'kb.delete',
      description: 'Delete a knowledge base with its documents, chunks and candidates.',
      risk: 'dangerous',
      input: z.object({ id: z.string() }),
      handler: ({ id }) => this.remove(id),
    })

    yield actions.define({
      name: 'kb.docs.list',
      description: 'Documents of a knowledge base with their status (pending, parsing, embedding, ready, error), size and chunk count.',
      risk: 'read',
      input: baseId,
      handler: ({ base }) => this.docs(base),
    })

    yield actions.define({
      name: 'kb.docs.add',
      description: 'Add a document to a knowledge base: pasted text (Markdown works best: headings become chunk titles), a web page url, or a file as base64 data with its name (md, txt, html; pdf and docx need optional packages). It is split and embedded in the background.',
      risk: 'write',
      input: baseId.extend({
        name: z.string().optional().describe('Title, or the file name for data'),
        text: z.string().optional(),
        url: z.string().optional(),
        data: z.string().optional().describe('File content in base64'),
      }),
      handler: (input) => this.addDoc(input),
    })

    yield actions.define({
      name: 'kb.docs.remove',
      description: 'Remove a document and its chunks from its knowledge base.',
      risk: 'dangerous',
      input: z.object({ id: z.string().describe('Document id') }),
      handler: ({ id }) => this.removeDoc(id),
    })

    yield actions.define({
      name: 'kb.docs.reparse',
      description: 'Split a document again from its file (a web page is fetched again). Edits to its chunks are lost.',
      risk: 'write',
      input: z.object({ id: z.string() }),
      handler: ({ id }) => this.reparse(id),
    })

    yield actions.define({
      name: 'kb.chunks.list',
      description: 'Chunks of a knowledge base (or one document), in order, optionally only those containing some text.',
      risk: 'read',
      input: baseId.extend({
        doc: z.string().optional(),
        query: z.string().optional().describe('Only chunks containing this text'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      handler: (input) => this.chunks(input),
    })

    yield actions.define({
      name: 'kb.chunks.add',
      description: 'Add one entry to a knowledge base (it goes in its "随手记" document), as /记住 does in chat.',
      risk: 'write',
      input: baseId.extend({ text: z.string().min(1), title: z.string().optional() }),
      handler: ({ base, text, title }) => this.addEntry(base, { text, title, meta: { by: 'dashboard' } }),
    })

    yield actions.define({
      name: 'kb.chunks.update',
      description: 'Change a chunk\'s title or text; it is embedded again.',
      risk: 'write',
      input: z.object({ id: z.string(), title: z.string().optional(), text: z.string().optional() }),
      handler: ({ id, ...patch }) => this.updateChunk(id, patch),
    })

    yield actions.define({
      name: 'kb.chunks.remove',
      description: 'Remove one chunk.',
      risk: 'write',
      input: z.object({ id: z.string() }),
      handler: ({ id }) => this.removeChunk(id),
    })

    yield actions.define({
      name: 'kb.chunks.merge',
      description: 'Join a chunk with the next one of its document.',
      risk: 'write',
      input: z.object({ id: z.string() }),
      handler: ({ id }) => this.mergeChunk(id),
    })

    yield actions.define({
      name: 'kb.search',
      description: 'Search knowledge bases (all when none are given) for passages about a question. Each hit has its text, title, document, a score from 0 to 1 (the better of meaning similarity and the share of the question\'s words it contains) and its ranks by keywords and by meaning. Answer from the hits and cite them; say so when nothing relevant is found.',
      risk: 'read',
      input: z.object({
        query: z.string().min(1),
        bases: z.array(z.string()).optional().describe('Base ids or names'),
        topK: z.number().int().min(1).max(20).optional(),
        minScore: z.number().min(0).max(1).optional(),
      }),
      handler: (input) => this.search(input),
    })

    yield actions.define({
      name: 'kb.reindex',
      description: 'Embed every chunk of a knowledge base again with its model, in the background.',
      risk: 'write',
      input: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        void this.reindex(id)
        return { ok: true }
      },
    })

    yield actions.define({
      name: 'kb.graph',
      description: 'Chunks of a knowledge base and links between similar ones (by embeddings, or shared words without them), for the similarity map.',
      risk: 'read',
      input: baseId.extend({
        neighbors: z.number().int().min(1).max(10).optional(),
        minSimilarity: z.number().min(0).max(1).optional(),
        limit: z.number().int().min(10).max(2000).optional(),
      }),
      handler: (input) => this.graph(input),
    })

    yield actions.define({
      name: 'kb.flowChoices',
      description: 'Flows with an "Ask the LLM" node, which kb.useInFlow can add a knowledge search to; says which already search the base.',
      risk: 'read',
      input: z.object({ base: z.string().optional() }),
      handler: ({ base }) => this.flowChoices(base),
    })

    yield actions.define({
      name: 'kb.useInFlow',
      description: 'Make a flow search knowledge bases before its first "Ask the LLM" node and give it the passages found (a bot\'s LLM chat flow, for example). A flow that already has a knowledge search node gets the bases added.',
      risk: 'write',
      input: z.object({ flow: z.string(), bases: z.array(z.string()).min(1) }),
      handler: ({ flow, bases }) => this.useInFlow(flow, bases),
    })

    yield actions.define({
      name: 'kb.candidates.list',
      description: 'Knowledge learned from chats, newest first: pending ones wait for review.',
      risk: 'read',
      input: baseId.extend({ status: z.enum(['pending', 'accepted', 'rejected']).optional() }),
      handler: ({ base, status }) => this.candidates(base, status),
    })

    yield actions.define({
      name: 'kb.candidates.accept',
      description: 'Add a learned candidate to its knowledge base, optionally with an edited question or answer.',
      risk: 'write',
      input: z.object({ id: z.number().int(), question: z.string().optional(), answer: z.string().optional() }),
      handler: ({ id, ...patch }) => this.accept(id, patch),
    })

    yield actions.define({
      name: 'kb.candidates.reject',
      description: 'Ignore a learned candidate.',
      risk: 'write',
      input: z.object({ id: z.number().int() }),
      handler: ({ id }) => this.reject(id),
    })

    yield actions.define({
      name: 'kb.learn',
      description: 'Learn from one chat now instead of waiting for enough messages: reads its messages since the last time and asks the LLM for knowledge worth keeping. Costs one LLM request.',
      risk: 'write',
      input: baseId.extend({ bot: z.string(), chat: z.string().regex(/^(group|private):\S+$/).describe('"group:<id>" or "private:<user id>"') }),
      handler: ({ base, bot, chat }) => this.learn(base, bot, chat),
    })
  }
}

export default Knowledge
