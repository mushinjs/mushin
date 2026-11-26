import { describe, expect, it } from 'vitest'
import { RepeatedLines, type RepeatOutput, SUMMARY_INTERVAL, summaryText } from '../src/log-repeats'
import { parseLogLevel } from '../src/start'

const MINUTE = 60_000
const at = (minutes: number) => Date.parse('2026-11-26T10:00:00') + minutes * MINUTE

const warn = (text: string, minutes: number, name = 'onebot') => ({ type: 'warn', name, text, ts: at(minutes) })
const info = (text: string, minutes: number, name = 'onebot') => ({ type: 'info', name, text, ts: at(minutes) })

/** What the terminal would show, in words. */
function show(outputs: RepeatOutput[]) {
  return outputs.map((out) => (out.kind === 'line' ? `${out.line.type} ${out.line.name}: ${out.line.text}` : `${out.name}: ${summaryText(out)}`))
}

/** The reconnect cycle of a bot whose OneBot server is down, every 30 seconds. */
function attempt(lines: RepeatedLines, minutes: number) {
  return [
    ...lines.handle(info('connecting to ws://127.0.0.1:6700 with a token', minutes)),
    ...lines.handle(warn(`cannot reach ws://127.0.0.1:6700: connect ECONNREFUSED 127.0.0.1:${6700 + (Math.round(minutes * 2) % 2)}`, minutes)),
    ...lines.handle(info('reconnecting in 30s', minutes)),
  ]
}

describe('repeated warnings in the terminal', () => {
  it('prints a warning once, counts its copies, and sums them up when a different one arrives', () => {
    const lines = new RepeatedLines()
    const out: RepeatOutput[] = []
    for (let i = 0; i < 6; i++) out.push(...attempt(lines, i * 0.5))
    out.push(...lines.handle(warn('the token was rejected', 3.2)))
    const warnings = show(out).filter((line) => !line.startsWith('info'))
    expect(warnings).toEqual([
      'warn onebot: cannot reach ws://127.0.0.1:6700: connect ECONNREFUSED 127.0.0.1:6700',
      // 10:02:30 in local time.
      `onebot: the same warning repeated 5 more times (latest ${new Date(at(2.5)).toTimeString().slice(0, 8)})`,
      'warn onebot: the token was rejected',
    ])
    // Info lines pass through untouched.
    expect(show(out).filter((line) => line.startsWith('info')).length).toBe(12)
  })

  it('sums up every ten minutes while the warning continues', () => {
    const lines = new RepeatedLines()
    const summaries: RepeatOutput[] = []
    for (let i = 0; i <= 50; i++) summaries.push(...attempt(lines, i * 0.5).filter((out) => out.kind === 'summary'))
    // 25 minutes of copies: one summary at 10 minutes, one at 20.
    expect(summaries.map((out) => out.kind === 'summary' && out.count)).toEqual([20, 20])
    expect(SUMMARY_INTERVAL).toBe(10 * MINUTE)
  })

  it('keeps sources and levels apart, and says nothing when a warning did not repeat', () => {
    const lines = new RepeatedLines()
    const out = [
      ...lines.handle(warn('disk almost full: 91%', 0, 'stats')),
      ...lines.handle(warn('disk almost full: 92%', 0.1, 'other')),
      ...lines.handle({ type: 'error', name: 'stats', text: 'disk almost full: 93%', ts: at(0.2) }),
      ...lines.handle(warn('something else', 0.3, 'stats')),
    ]
    expect(show(out)).toEqual([
      'warn stats: disk almost full: 91%',
      'warn other: disk almost full: 92%',
      'error stats: disk almost full: 93%',
      'warn stats: something else',
    ])
  })

  it('words a single repeat and an error', () => {
    expect(summaryText({ type: 'error', count: 1, latest: at(0) })).toMatch(/^the same error repeated 1 more time \(latest \d\d:\d\d:\d\d\)$/)
  })
})

describe('--log-level', () => {
  it('takes the four levels and names them when the value is wrong', () => {
    expect(parseLogLevel('WARN')).toBe('warn')
    expect(parseLogLevel(undefined)).toBeUndefined()
    expect(parseLogLevel('')).toBeUndefined()
    expect(() => parseLogLevel('loud', 'MUSHIN_LOG_LEVEL')).toThrow('MUSHIN_LOG_LEVEL must be one of error, warn, info, debug, not "loud"')
  })
})
