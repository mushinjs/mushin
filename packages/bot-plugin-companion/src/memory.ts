import type { MessageRecord } from '@mushin/core'
import { DIGEST_EVERY, DIGEST_SYSTEM, digestPrompt, mergePeople, newMemories, nextSummary, parseDigest } from './digest'
import { recall } from './recall'
import type { MemoryItem, MemoryStore, PersonCard } from './store'
import { buildTranscript } from './transcript'

/** Most messages one digest reads; older unread ones are left out. */
const DIGEST_WINDOW = 80
/** People whose cards go into one prompt. */
const CARDS = 3
/** Messages from people the recall query reads. */
const RECALL_WINDOW = 8

/** What the companion has in mind about a chat when it looks at it. */
export interface Recollection {
  summary?: string
  people: PersonCard[]
  memories: MemoryItem[]
}

export interface MemoryDeps {
  bot: string
  store: MemoryStore
  selfId?: string
  selfName: string
  /** Asks the summary model; returns its text. */
  ask(messages: { role: 'system' | 'user'; content: string }[]): Promise<string>
  /** Embeds texts, when the companion has an embedding model. */
  embed?(texts: string[]): Promise<number[][]>
  now?(): number
  onError?(error: unknown, chat: string): void
}

const people = (records: MessageRecord[], selfId?: string) => {
  const names = new Map<string, string>()
  // Newest speaker first.
  for (const record of [...records].reverse()) {
    if (record.direction === 'out' || record.user.id === selfId) continue
    if (!names.has(record.user.id)) names.set(record.user.id, record.user.name || record.user.id)
  }
  return names
}

/**
 * One bot's memory: counts new messages per chat, digests them into a summary, memories and
 * impressions every so often, and recalls what fits the chat at hand.
 */
export class Memory {
  private unread = new Map<string, number>()
  private digesting = new Set<string>()

  constructor(private deps: MemoryDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  /** A message arrived in a remembered chat; digests once enough have piled up. */
  observe(chat: string, history: (limit: number) => Promise<MessageRecord[]>) {
    const count = (this.unread.get(chat) ?? 0) + 1
    this.unread.set(chat, count)
    if (count < DIGEST_EVERY || this.digesting.has(chat)) return
    this.unread.set(chat, 0)
    this.digesting.add(chat)
    void this.digest(chat, history).catch((error) => this.deps.onError?.(error, chat)).finally(() => this.digesting.delete(chat))
  }

  /** Reads the messages since the last digest and saves what the model took from them. */
  async digest(chat: string, history: (limit: number) => Promise<MessageRecord[]>) {
    const { bot, store } = this.deps
    const previous = await store.summary(bot, chat)
    const records = (await history(DIGEST_WINDOW)).filter((record) => record.timestamp > (previous?.until ?? 0))
    const names = people(records, this.deps.selfId)
    if (!names.size) return
    const cards = await store.people(bot, [...names.keys()])
    const transcript = buildTranscript(records, { selfId: this.deps.selfId, selfName: this.deps.selfName, userIds: true, maxChars: 200 })
    const answer = await this.deps.ask([
      { role: 'system', content: DIGEST_SYSTEM },
      { role: 'user', content: digestPrompt({ summary: previous?.summary, people: cards, transcript: transcript.text }) },
    ])
    const digest = parseDigest(answer, new Set(names.keys()))
    if (!digest) throw new Error('digest answer unreadable')
    const now = this.now()
    const vectors = digest.memories.length && this.deps.embed
      ? await this.deps.embed(digest.memories.map((item) => item.text)).catch((error) => void this.deps.onError?.(error, chat))
      : undefined
    await store.addMemories(newMemories(bot, chat, digest, now, vectors || undefined))
    await store.savePeople(mergePeople(bot, cards, digest, names, now))
    await store.saveSummary(nextSummary(bot, chat, previous, digest, records.at(-1)!.timestamp, now))
  }

  /** The summary, the cards of the people talking and the memories that fit the recent chat. */
  async recall(chat: string, records: MessageRecord[]): Promise<Recollection> {
    const { bot, store } = this.deps
    const names = people(records, this.deps.selfId)
    const recent = records.filter((record) => record.direction === 'in').slice(-RECALL_WINDOW)
    const text = buildTranscript(recent, { selfId: this.deps.selfId }).lines.map((line) => line.text).join('\n')
    const [summary, cards, items] = await Promise.all([
      store.summary(bot, chat),
      store.people(bot, [...names.keys()].slice(0, CARDS)),
      store.memories(bot, chat),
    ])
    let vector: number[] | undefined
    if (this.deps.embed && text && items.some((item) => item.vector)) {
      vector = (await this.deps.embed([text]).catch((error) => void this.deps.onError?.(error, chat)))?.[0]
    }
    const memories = text ? recall(items, { text, vector, people: [...names.keys()], now: this.now() }) : []
    if (memories.length) await store.touch(memories.map((item) => item.id), this.now())
    const order = [...names.keys()]
    return {
      summary: summary?.summary || undefined,
      people: cards.sort((a, b) => order.indexOf(a.user) - order.indexOf(b.user)),
      memories,
    }
  }
}

const closeness = (affinity: number) => affinity >= 0.5 ? '很熟' : affinity >= 0.2 ? '挺熟' : affinity <= -0.3 ? '有点合不来' : ''

/** What the companion remembers, as a block for the planner and replier prompts; empty when nothing. */
export function recollectionText(recollection: Recollection | undefined) {
  if (!recollection) return ''
  const parts: string[] = []
  if (recollection.summary) parts.push(`之前聊过的：${recollection.summary}`)
  const cards = recollection.people.filter((card) => card.impression || card.facts.length)
  if (cards.length) {
    parts.push(`你对他们的印象：\n${cards.map((card) => {
      const close = closeness(card.affinity)
      return `- ${card.name}[${card.user}]：${[card.impression, ...card.facts.slice(-4), close && `你们${close}`].filter(Boolean).join('；')}`
    }).join('\n')}`)
  }
  if (recollection.memories.length) parts.push(`你想起来的事：\n${recollection.memories.map((item) => `- ${item.text}`).join('\n')}`)
  return parts.length ? `<memory>\n${parts.join('\n')}\n</memory>` : ''
}
