// Folds repeated log lines for display. Dependency-free, so the dashboard imports it as
// `@mushinjs/core/log-fold` without the rest of the core.
//
// Only adjacent repeats fold: one line repeating, or a block of up to `maxPeriod` lines repeating back to back,
// such as a bot that cannot reach its server and logs "connecting", "cannot reach" and "reconnecting in 30s"
// every 30 seconds. Any other line in between ends the fold. The stored log stays as it was.

/** What folding compares of a line. */
export interface FoldableLine {
  /** The level. */
  type: string
  /** The source. */
  name: string
  text: string
}

/**
 * A run of lines, `lines[start]` to `lines[start + period * count - 1]`: one block of `period` lines that
 * occurs `count` times in a row. A line that does not repeat is a fold of period 1 and count 1.
 */
export interface Fold {
  start: number
  period: number
  count: number
}

export interface FoldOptions<T> {
  /** The longest block that folds. Default 5. */
  maxPeriod?: number
  /** Lines with equal keys are the same; default `foldKey`. Pass a cached one for long logs. */
  key?: (line: T) => string
}

const DIGITS = /\d+/g

/** Level, source and text with every run of digits replaced, so counters, times and ports do not matter. */
export function foldKey(line: FoldableLine) {
  return `${line.type}\u0000${line.name}\u0000${line.text.replace(DIGITS, '#')}`
}

/**
 * Splits lines into folds, in order; every line is in exactly one. Where blocks of several lengths repeat
 * at the same place, the one that covers the most lines wins, and of those the shortest block.
 */
export function foldLines<T extends FoldableLine>(lines: readonly T[], options: FoldOptions<T> = {}): Fold[] {
  const maxPeriod = options.maxPeriod ?? 5
  const keyOf = options.key ?? foldKey
  const keys = lines.map((line) => keyOf(line))
  const folds: Fold[] = []
  let i = 0
  while (i < keys.length) {
    let best: Fold = { start: i, period: 1, count: 1 }
    for (let period = 1; period <= maxPeriod && i + 2 * period <= keys.length; period++) {
      const count = repeats(keys, i, period)
      if (count > 1 && count * period > best.count * best.period) best = { start: i, period, count }
    }
    folds.push(best)
    i += best.period * best.count
  }
  return folds
}

/** How many times the block of `period` keys at `start` occurs back to back from there. */
function repeats(keys: string[], start: number, period: number) {
  let count = 1
  for (let at = start + period; at + period <= keys.length; at += period) {
    for (let j = 0; j < period; j++) {
      if (keys[at + j] !== keys[start + j]) return count
    }
    count++
  }
  return count
}

/** Lines that folding hid: the lines of all folds minus one block of each. */
export function foldedCount(folds: readonly Fold[]) {
  let hidden = 0
  for (const fold of folds) hidden += fold.period * (fold.count - 1)
  return hidden
}
