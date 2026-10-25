import { describe, expect, it } from 'vitest'
import { compact, dayHour, dayStart, emptyCounters, merge, metricValues, top } from '../src'

const hour = (fill: (counters: ReturnType<typeof emptyCounters>) => void) => {
  const counters = emptyCounters()
  fill(counters)
  return counters
}

describe('counters', () => {
  it('keys days and hours in local time', () => {
    const time = new Date(2026, 9, 25, 9, 30).getTime()
    expect(dayHour(time)).toEqual(['2026-10-25', '09'])
    expect(dayStart('2026-10-25')).toBe(new Date(2026, 9, 25).getTime())
  })

  it('folds a day into one bucket', () => {
    const doc = {
      day: '2026-10-25',
      names: {},
      hours: {
        '09': hour((c) => { c.in.a = 2; c.llm['P|m'] = { calls: 1, errors: 0, tokens: 10 } }),
        '10': hour((c) => { c.in.a = 1; c.out.b = 4; c.llm['P|m'] = { calls: 2, errors: 1, tokens: 5 } }),
      },
    }
    const folded = compact(doc)
    expect(Object.keys(folded.hours)).toEqual(['*'])
    expect(folded.hours['*']).toMatchObject({ in: { a: 3 }, out: { b: 4 }, llm: { 'P|m': { calls: 3, errors: 1, tokens: 15 } } })
  })

  it('splits metrics into series and ranks dimensions', () => {
    const counters = merge(emptyCounters(), hour((c) => {
      c.in = { a: 2, b: 1 }
      c.out = { a: 1 }
      c.commands = { 'a|ping': 3, 'a|help': 5 }
    }))
    expect(metricValues(counters, 'messages')).toEqual({ a: 3, b: 1 })
    expect(metricValues(counters, 'commands')).toEqual({ total: 8 })
    expect(top(counters, 'commands', 1)).toEqual([['a|help', 5]])
  })
})
