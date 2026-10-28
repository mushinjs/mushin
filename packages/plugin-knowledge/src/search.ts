/**
 * Hybrid search over the chunks of one knowledge base: BM25 over words (CJK text as pairs of
 * characters) and cosine similarity over embeddings, fused by reciprocal rank.
 */

const CJK = /[㐀-鿿豈-﫿]/
const WORD = /[\p{L}\p{N}]+/gu

/**
 * Words of a text for keyword search: Latin words and numbers as they are, runs of CJK characters
 * as overlapping pairs (`能发广告` → `能发 发广 广告`), a lone CJK character as itself. Pairs work
 * without a dictionary; SQLite's trigram tokenizer cannot match two-character words at all.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const [word] of text.toLowerCase().normalize('NFKC').matchAll(WORD)) {
    let latin = ''
    let cjk = ''
    const flush = () => {
      if (latin) tokens.push(latin)
      if (cjk.length === 1) tokens.push(cjk)
      for (let index = 0; index < cjk.length - 1; index++) tokens.push(cjk.slice(index, index + 2))
      latin = ''
      cjk = ''
    }
    for (const char of word) {
      if (CJK.test(char)) {
        if (latin) flush()
        cjk += char
      } else {
        if (cjk) flush()
        latin += char
      }
    }
    flush()
  }
  return tokens
}

/** A vector scaled to length 1, so a dot product is the cosine similarity. */
export function normalize(vector: ArrayLike<number>): Float32Array {
  const result = Float32Array.from(vector)
  let sum = 0
  for (const value of result) sum += value * value
  const norm = Math.sqrt(sum)
  if (norm > 0) for (let index = 0; index < result.length; index++) result[index] /= norm
  return result
}

export function dot(a: Float32Array, b: Float32Array) {
  let sum = 0
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index++) sum += a[index] * b[index]
  return sum
}

export interface IndexedChunk {
  id: string
  doc: string
  title: string
  text: string
  /** Length 1; missing until the chunk is embedded. */
  vector?: Float32Array
}

export interface SearchOptions {
  topK?: number
  /** Hits whose score (the better of similarity and keyword coverage) is lower are dropped. */
  minScore?: number
}

export interface SearchHit {
  id: string
  doc: string
  title: string
  text: string
  /** What `minScore` compares: the better of `similarity` and `coverage`, 0 to 1. */
  score: number
  /** Cosine similarity to the question, when both are embedded. */
  similarity?: number
  /** Share of the question's words found in the chunk, 0 to 1. */
  coverage: number
  /** BM25 score; 0 when no word matched. */
  bm25: number
  /** Place in each list (from 1), and the fused order that decides the result. */
  ranks: { keyword?: number; vector?: number }
  fused: number
}

const K1 = 1.2
const B = 0.75
/** Reciprocal rank fusion constant; 60 is the usual choice. */
const RRF_K = 60
/** How many of each list take part in fusion. */
const CANDIDATES = 50

interface Entry {
  chunk: IndexedChunk
  terms: Map<string, number>
  length: number
}

export class SearchIndex {
  private entries = new Map<string, Entry>()
  private df = new Map<string, number>()
  private totalLength = 0

  constructor(chunks: IndexedChunk[] = []) {
    for (const chunk of chunks) this.add(chunk)
  }

  get size() {
    return this.entries.size
  }

  /** Chunks that have a vector. */
  get embedded() {
    let count = 0
    for (const entry of this.entries.values()) if (entry.chunk.vector) count++
    return count
  }

  chunks() {
    return [...this.entries.values()].map((entry) => entry.chunk)
  }

  get(id: string) {
    return this.entries.get(id)?.chunk
  }

  add(chunk: IndexedChunk) {
    this.remove(chunk.id)
    const terms = new Map<string, number>()
    const tokens = tokenize(`${chunk.title}\n${chunk.text}`)
    for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1)
    for (const token of terms.keys()) this.df.set(token, (this.df.get(token) ?? 0) + 1)
    this.entries.set(chunk.id, { chunk, terms, length: tokens.length })
    this.totalLength += tokens.length
  }

  remove(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    for (const token of entry.terms.keys()) {
      const count = (this.df.get(token) ?? 1) - 1
      if (count > 0) this.df.set(token, count)
      else this.df.delete(token)
    }
    this.totalLength -= entry.length
    this.entries.delete(id)
  }

  private idf(token: string) {
    const n = this.entries.size
    const df = this.df.get(token) ?? 0
    return Math.log(1 + (n - df + 0.5) / (df + 0.5))
  }

  /** Searches by words, and by meaning when a normalized question vector is given. */
  search(text: string, vector: Float32Array | undefined, options: SearchOptions = {}): SearchHit[] {
    const topK = options.topK ?? 5
    const minScore = options.minScore ?? 0
    const query = [...new Set(tokenize(text))]
    const average = this.entries.size ? this.totalLength / this.entries.size : 0

    const keyword: { entry: Entry; bm25: number; coverage: number }[] = []
    const vectorList: { entry: Entry; similarity: number }[] = []
    for (const entry of this.entries.values()) {
      let bm25 = 0
      let matched = 0
      for (const token of query) {
        const tf = entry.terms.get(token)
        if (!tf) continue
        matched++
        const norm = 1 - B + B * (average ? entry.length / average : 1)
        bm25 += this.idf(token) * (tf * (K1 + 1)) / (tf + K1 * norm)
      }
      if (bm25 > 0) keyword.push({ entry, bm25, coverage: query.length ? matched / query.length : 0 })
      if (vector && entry.chunk.vector && entry.chunk.vector.length === vector.length) {
        vectorList.push({ entry, similarity: dot(vector, entry.chunk.vector) })
      }
    }
    keyword.sort((a, b) => b.bm25 - a.bm25)
    vectorList.sort((a, b) => b.similarity - a.similarity)

    const hits = new Map<string, SearchHit>()
    const hitOf = (entry: Entry) => {
      let hit = hits.get(entry.chunk.id)
      if (!hit) {
        const { id, doc, title, text } = entry.chunk
        hit = { id, doc, title, text, score: 0, coverage: 0, bm25: 0, ranks: {}, fused: 0 }
        hits.set(id, hit)
      }
      return hit
    }
    keyword.slice(0, CANDIDATES).forEach((item, index) => {
      const hit = hitOf(item.entry)
      hit.bm25 = item.bm25
      hit.coverage = item.coverage
      hit.ranks.keyword = index + 1
      hit.fused += 1 / (RRF_K + index + 1)
    })
    vectorList.slice(0, CANDIDATES).forEach((item, index) => {
      const hit = hitOf(item.entry)
      hit.similarity = item.similarity
      hit.ranks.vector = index + 1
      hit.fused += 1 / (RRF_K + index + 1)
    })
    for (const hit of hits.values()) hit.score = Math.max(hit.similarity ?? 0, hit.coverage)
    return [...hits.values()]
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.fused - a.fused || b.score - a.score)
      .slice(0, topK)
  }

  /**
   * Pairs of similar chunks, for the similarity map: each chunk's closest `neighbors` above
   * `minSimilarity`. Uses vectors when chunks have them, shared words otherwise.
   */
  links(options: { neighbors?: number; minSimilarity?: number; limit?: number } = {}) {
    const neighbors = options.neighbors ?? 3
    const minSimilarity = options.minSimilarity ?? 0.6
    const entries = [...this.entries.values()].slice(0, options.limit ?? 500)
    const byVector = entries.length > 0 && entries.every((entry) => entry.chunk.vector)
    const similarity = (a: Entry, b: Entry) => {
      if (byVector) return dot(a.chunk.vector!, b.chunk.vector!)
      let shared = 0
      for (const token of a.terms.keys()) if (b.terms.has(token)) shared++
      const union = a.terms.size + b.terms.size - shared
      return union ? shared / union : 0
    }
    const edges = new Map<string, { source: string; target: string; similarity: number }>()
    for (const a of entries) {
      const closest = entries
        .filter((b) => b !== a)
        .map((b) => ({ b, value: similarity(a, b) }))
        .filter((item) => item.value >= minSimilarity)
        .sort((x, y) => y.value - x.value)
        .slice(0, neighbors)
      for (const { b, value } of closest) {
        const [source, target] = a.chunk.id < b.chunk.id ? [a.chunk.id, b.chunk.id] : [b.chunk.id, a.chunk.id]
        edges.set(`${source}|${target}`, { source, target, similarity: Math.round(value * 1000) / 1000 })
      }
    }
    return { nodes: entries.map((entry) => entry.chunk), edges: [...edges.values()], byVector }
  }
}

/** Hits as numbered passages for a model: `[1] title` and the text. */
export function passages(hits: { title: string; text: string; docTitle?: string }[]) {
  return hits.map((hit, index) => `[${index + 1}] ${hit.title || hit.docTitle || ''}\n${hit.text}`.trim()).join('\n\n')
}
