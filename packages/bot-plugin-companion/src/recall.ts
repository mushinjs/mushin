import type { MemoryItem } from './store'

/** Memories brought into one look at a chat. */
export const RECALL_COUNT = 3
/** Memories lose half their recency weight after this long. */
const RECENCY_HALF_LIFE = 14 * 24 * 3600_000
/** Below this a memory is not about the chat at hand: about one shared pair of characters in ten. */
const MIN_RELEVANCE = 0.08
/** Embeddings of unrelated texts still come out somewhat similar. */
const MIN_SIMILARITY = 0.3

const CJK = /[㐀-鿿豈-﫿]/

/** Words of a text: Latin words as they are, CJK runs as overlapping pairs of characters. */
export function words(text: string) {
  const result = new Set<string>()
  for (const [run] of text.toLowerCase().normalize('NFKC').matchAll(/[\p{L}\p{N}]+/gu)) {
    let cjk = ''
    let latin = ''
    const flush = () => {
      if (latin.length > 1) result.add(latin)
      if (cjk.length === 1) result.add(cjk)
      for (let index = 0; index < cjk.length - 1; index++) result.add(cjk.slice(index, index + 2))
      cjk = ''
      latin = ''
    }
    for (const char of run) {
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
  return result
}

export function cosine(a: number[], b: number[]) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    dot += a[index] * b[index]
    na += a[index] * a[index]
    nb += b[index] * b[index]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

export interface RecallQuery {
  /** The recent chat, as plain text. */
  text: string
  /** Its embedding, when the companion has an embedding model. */
  vector?: number[]
  /** People in the recent chat. */
  people: string[]
  now: number
}

/**
 * The memories most worth recalling now: by meaning when both sides are embedded, else by shared
 * words; a memory about someone present counts for more, and recent ones for a little more.
 */
export function recall(items: MemoryItem[], query: RecallQuery, count = RECALL_COUNT): MemoryItem[] {
  const queryWords = words(query.text)
  const present = new Set(query.people)
  const scored = items.map((item) => {
    let relevance: number
    if (query.vector && item.vector) relevance = cosine(query.vector, item.vector) - MIN_SIMILARITY + MIN_RELEVANCE
    else {
      const own = words(`${item.text} ${item.topic}`)
      let shared = 0
      for (const word of own) if (queryWords.has(word)) shared++
      relevance = own.size ? shared / Math.sqrt(own.size * Math.max(1, queryWords.size)) : 0
    }
    const about = item.people.some((user) => present.has(user)) ? 0.15 : 0
    const recency = 0.05 * 0.5 ** ((query.now - item.createdAt) / RECENCY_HALF_LIFE)
    return { item, relevance, score: relevance + about + recency }
  })
  return scored.filter((entry) => entry.relevance >= MIN_RELEVANCE)
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((entry) => entry.item)
}
