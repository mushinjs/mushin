import type { MessageRecord } from '@mushinjs/core'

/** What the companion notices in a batch of new messages, scored by rules alone (no model call). */
export interface Interest {
  /** Someone spoke to the bot directly: an @-mention, a reply to its message, or a private chat. */
  addressed: boolean
  score: number
  reasons: string[]
}

export interface InterestOptions {
  selfId?: string
  aliases: string[]
  interests: string[]
  /** 0 to 1; scales everything but being addressed. */
  talkValue: number
  /** The chat's recent messages before the batch, oldest first. */
  before: MessageRecord[]
  now: number
}

const QUESTION = /[?？]\s*$|[吗呢么嘛]\s*[?？]?\s*$/
const textOf = (record: MessageRecord) => record.segments.filter((s) => s.type === 'text').map((s) => s.data.text ?? '').join('')

/** Scores a batch of new messages from people in one chat. */
export function interestOf(batch: MessageRecord[], options: InterestOptions): Interest {
  const reasons: string[] = []
  const selfId = options.selfId
  const ownIds = new Set(options.before.filter((record) => record.direction === 'out' && record.messageId).map((record) => record.messageId!))
  const addressed = batch.some((record) => record.channel.type === 'private'
    || record.segments.some((s) => (s.type === 'at' && selfId && String(s.data.qq) === selfId) || (s.type === 'reply' && ownIds.has(String(s.data.id)))))
  if (addressed) reasons.push('addressed')

  const text = batch.map(textOf).join('\n').toLowerCase()
  let score = 0.1
  if (options.aliases.some((alias) => alias.trim() && text.includes(alias.trim().toLowerCase()))) {
    score += 0.6
    reasons.push('named')
  }
  const hits = options.interests.filter((word) => word.trim() && text.includes(word.trim().toLowerCase()))
  if (hits.length) {
    score += Math.min(0.45, hits.length * 0.3)
    reasons.push(`topic:${hits.join(',')}`)
  }
  if (batch.some((record) => QUESTION.test(textOf(record)))) {
    score += 0.15
    reasons.push('question')
  }
  // Right after the bot spoke, people are often answering it.
  const recent = options.before.slice(-3)
  const lastOwn = [...options.before].reverse().find((record) => record.direction === 'out')
  if (lastOwn && recent.includes(lastOwn) && options.now - lastOwn.timestamp < 3 * 60_000) {
    score += 0.35
    reasons.push('follows-up')
    if (options.now - lastOwn.timestamp < 30_000) {
      score *= 0.5
      reasons.push('just-spoke')
    }
  }
  // A busy chat needs the bot less.
  const lastMinute = options.before.filter((record) => record.direction === 'in' && options.now - record.timestamp < 60_000).length + batch.length
  if (lastMinute > 20) {
    score *= 0.6
    reasons.push('busy')
  }
  return { addressed, score: score * options.talkValue * 2, reasons }
}

/** Backoff after the planner decided to stay quiet: from 15 seconds, doubling, at most 5 minutes. */
export const BACKOFF = { base: 15_000, cap: 300_000 }
const HALF_LIFE = 60_000

/**
 * How much the bot wants to speak in one chat: interest adds up and fades with a one-minute half
 * life. Past the threshold the planner is asked; after it stays quiet, only being addressed asks it
 * again until the backoff ends.
 */
export class Willingness {
  value = 0
  private at = 0
  private backoff = 0
  quietUntil = 0

  constructor(public threshold = 1) {}

  private fade(now: number) {
    if (this.at) this.value *= 0.5 ** ((now - this.at) / HALF_LIFE)
    this.at = now
  }

  /** Adds a batch's interest; true when the planner should look at the chat. */
  add(interest: Interest, now: number) {
    this.fade(now)
    this.value += interest.score
    if (interest.addressed) return true
    return now >= this.quietUntil && this.value >= this.threshold
  }

  /** The planner chose not to speak. */
  stayedQuiet(now: number) {
    this.backoff = this.backoff ? Math.min(this.backoff * 2, BACKOFF.cap) : BACKOFF.base
    this.quietUntil = now + this.backoff
    this.value = 0
  }

  /** The bot spoke: its urge is spent and the backoff starts over. */
  spoke(now: number) {
    this.backoff = 0
    this.quietUntil = 0
    this.value = 0
    this.at = now
  }
}
