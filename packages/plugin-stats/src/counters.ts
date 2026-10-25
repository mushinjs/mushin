/** Counts for one hour. Keys hold the bot id where it matters, e.g. `${botId}|${userId}`. */
export interface Counters {
  /** Bot id → messages received. */
  in: Record<string, number>
  /** Bot id → messages sent. */
  out: Record<string, number>
  /** `${botId}|${type}:${id}` → messages received in that chat. */
  channels: Record<string, number>
  /** `${botId}|${userId}` → messages received from that person. */
  users: Record<string, number>
  /** `${botId}|${command}` → times the command ran. */
  commands: Record<string, number>
  /** Flow id → live runs. */
  flows: Record<string, number>
  /** Flow id → live runs that failed. */
  flowErrors: Record<string, number>
  /** `${provider name}|${model}` → model requests. */
  llm: Record<string, { calls: number; errors: number; tokens: number }>
}

/**
 * One local day: counters per hour (`00`–`23`). Days older than the hourly retention keep one
 * bucket, `*`, for the whole day. `names` remembers display names of chats, people and flows.
 */
export interface DayDoc {
  day: string
  hours: Record<string, Counters>
  names: Record<string, string>
}

export const emptyCounters = (): Counters => ({ in: {}, out: {}, channels: {}, users: {}, commands: {}, flows: {}, flowErrors: {}, llm: {} })

const pad = (value: number) => String(value).padStart(2, '0')

/** Local date and hour of a time, e.g. `['2026-10-25', '09']`. */
export function dayHour(time: number | Date): [string, string] {
  const date = new Date(time)
  return [`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, pad(date.getHours())]
}

/** Midnight of a local day key. */
export function dayStart(day: string) {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date).getTime()
}

export function bump(map: Record<string, number>, key: string, by = 1) {
  map[key] = (map[key] ?? 0) + by
}

/** Adds `from` into `into`. */
export function merge(into: Counters, from: Counters) {
  for (const key of ['in', 'out', 'channels', 'users', 'commands', 'flows', 'flowErrors'] as const) {
    for (const [name, count] of Object.entries(from[key] ?? {})) bump(into[key], name, count)
  }
  for (const [name, usage] of Object.entries(from.llm ?? {})) {
    const entry = into.llm[name] ??= { calls: 0, errors: 0, tokens: 0 }
    entry.calls += usage.calls
    entry.errors += usage.errors
    entry.tokens += usage.tokens
  }
  return into
}

/** A day with its hours folded into one bucket, for days kept only as daily totals. */
export function compact(doc: DayDoc): DayDoc {
  const total = emptyCounters()
  for (const counters of Object.values(doc.hours)) merge(total, counters)
  return { ...doc, hours: { '*': total } }
}

export const sum = (map: Record<string, number>) => Object.values(map).reduce((total, value) => total + value, 0)

export type Metric = 'messages' | 'received' | 'sent' | 'commands' | 'flows' | 'llmCalls' | 'llmTokens'

/**
 * The value of a metric in one bucket, split into series: messages by bot, model usage by
 * provider and model; the rest as one `total` series.
 */
export function metricValues(counters: Counters, metric: Metric): Record<string, number> {
  switch (metric) {
    case 'messages': {
      const values: Record<string, number> = {}
      for (const key of ['in', 'out'] as const) for (const [bot, count] of Object.entries(counters[key])) bump(values, bot, count)
      return values
    }
    case 'received': return { ...counters.in }
    case 'sent': return { ...counters.out }
    case 'commands': return { total: sum(counters.commands) }
    case 'flows': return { total: sum(counters.flows) }
    case 'llmCalls': return Object.fromEntries(Object.entries(counters.llm).map(([key, usage]) => [key, usage.calls]))
    case 'llmTokens': return Object.fromEntries(Object.entries(counters.llm).map(([key, usage]) => [key, usage.tokens]))
  }
}

export type Dimension = 'channels' | 'users' | 'commands' | 'flows' | 'llm'

/** Counts of one dimension, highest first. */
export function top(counters: Counters, dimension: Dimension, limit: number) {
  const entries = dimension === 'llm'
    ? Object.entries(counters.llm).map(([key, usage]) => [key, usage.calls] as const)
    : Object.entries(counters[dimension])
  return entries.sort((a, b) => b[1] - a[1]).slice(0, limit)
}
