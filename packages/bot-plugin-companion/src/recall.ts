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

/** Characters too common to tell texts apart. */
const COMMON = new Set('的了是在我你他她它们这那就也都和吗呢啊吧呀有不个么什说一人要去来到会好着没还'.split(''))

/** The CJK characters of a text, less the most common ones: they match where pairs miss (家猫, 的猫). */
export function characters(text: string) {
  return new Set([...text.normalize('NFKC')].filter((char) => CJK.test(char) && !COMMON.has(char)))
}

/** How much of two sets of words overlap, 0 to 1. */
const overlap = (own: Set<string>, query: Set<string>) => {
  let shared = 0
  for (const word of own) if (query.has(word)) shared++
  return own.size ? shared / Math.sqrt(own.size * Math.max(1, query.size)) : 0
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
  const queryChars = characters(query.text)
  const present = new Set(query.people)
  const scored = items.map((item) => {
    let relevance: number
    if (query.vector && item.vector) relevance = cosine(query.vector, item.vector) - MIN_SIMILARITY + MIN_RELEVANCE
    else {
      const text = `${item.text} ${item.topic}`
      relevance = overlap(words(text), queryWords) + overlap(characters(text), queryChars) / 2
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
