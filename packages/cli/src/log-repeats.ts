// Keeps a warning or error that repeats from filling the terminal. The first copy prints; later copies
// from the same source are counted, and a summary line says how many there were: every ten minutes while
// they continue, and once a different warning or error from that source arrives. Info and debug lines
// pass through and do not end a repeat, so a cycle such as "connecting" / "cannot reach" / "reconnecting"
// prints its warning once at any log level. The dashboard's Logs page keeps every line.

export interface RepeatLine {
  type: string
  /** The source (logger name). */
  name: string
  text: string
  ts: number
}

/** What to print: the line itself, or a summary of the copies of an earlier one. */
export type RepeatOutput =
  | { kind: 'line'; line: RepeatLine }
  | { kind: 'summary'; type: string; name: string; count: number; latest: number }

interface Repeat {
  key: string
  type: string
  count: number
  latest: number
  /** When the last summary was printed, or the first copy if none was. */
  since: number
}

export const SUMMARY_INTERVAL = 10 * 60_000

const DIGITS = /\d+/g

export class RepeatedLines {
  private bySource = new Map<string, Repeat>()

  constructor(private interval = SUMMARY_INTERVAL) {}

  /** The lines to print for this one, in order. */
  handle(line: RepeatLine): RepeatOutput[] {
    if (line.type !== 'warn' && line.type !== 'error') return [{ kind: 'line', line }]
    const key = `${line.type}\u0000${line.text.replace(DIGITS, '#')}`
    const repeat = this.bySource.get(line.name)
    if (repeat?.key === key) {
      repeat.count++
      repeat.latest = line.ts
      if (line.ts - repeat.since < this.interval) return []
      repeat.since = line.ts
      return [this.summary(line.name, repeat)]
    }
    const out: RepeatOutput[] = repeat?.count ? [this.summary(line.name, repeat)] : []
    this.bySource.set(line.name, { key, type: line.type, count: 0, latest: line.ts, since: line.ts })
    out.push({ kind: 'line', line })
    return out
  }

  private summary(name: string, repeat: Repeat): RepeatOutput {
    const count = repeat.count
    repeat.count = 0
    return { kind: 'summary', type: repeat.type, name, count, latest: repeat.latest }
  }
}

/** "the same warning repeated 12 more times (latest 10:21:33)" */
export function summaryText(summary: { type: string; count: number; latest: number }) {
  const what = summary.type === 'error' ? 'error' : 'warning'
  const times = summary.count === 1 ? 'time' : 'times'
  return `the same ${what} repeated ${summary.count} more ${times} (latest ${clock(summary.latest)})`
}

export function clock(ts: number) {
  return new Date(ts).toTimeString().slice(0, 8)
}
