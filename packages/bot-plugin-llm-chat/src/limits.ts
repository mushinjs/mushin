/** Sliding-window counter: at most `limit` events per `windowMs` for each key. */
export class RateWindow {
  private hits = new Map<string, number[]>()

  constructor(private limit: number, private windowMs: number) {}

  private recent(key: string, now: number) {
    const list = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs)
    if (list.length) this.hits.set(key, list)
    else this.hits.delete(key)
    return list
  }

  /** True when another event is allowed for this key right now. */
  allows(key: string, now = Date.now()) {
    return this.limit <= 0 || this.recent(key, now).length < this.limit
  }

  record(key: string, now = Date.now()) {
    if (this.limit <= 0) return
    this.hits.set(key, [...this.recent(key, now), now])
  }
}

/** Local calendar day, `YYYY-MM-DD`; daily budgets reset at local midnight. */
export function localDay(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export interface DailyCounts {
  day: string
  replies: number
  tokens: number
}

/** Replies and tokens used today, persisted so a restart does not reset the budget. */
export class DailyUsage {
  counts: DailyCounts = { day: localDay(), replies: 0, tokens: 0 }

  constructor(private persist: (counts: DailyCounts) => Promise<void>) {}

  load(saved: DailyCounts | undefined) {
    if (saved && saved.day === localDay()) this.counts = { ...saved }
  }

  /** Starts a fresh count when the day has changed. */
  current() {
    const today = localDay()
    if (this.counts.day !== today) this.counts = { day: today, replies: 0, tokens: 0 }
    return this.counts
  }

  /** Which budget is used up, if any. A limit of 0 means no limit. */
  exhausted(limits: { replies: number; tokens: number }): 'replies' | 'tokens' | undefined {
    const counts = this.current()
    if (limits.replies > 0 && counts.replies >= limits.replies) return 'replies'
    if (limits.tokens > 0 && counts.tokens >= limits.tokens) return 'tokens'
  }

  add(tokens: number) {
    const counts = this.current()
    counts.replies += 1
    counts.tokens += tokens
    return this.persist({ ...counts })
  }
}
