import { describe, expect, it } from 'vitest'
import { DailyUsage, localDay, RateWindow } from '../src/limits'

describe('RateWindow', () => {
  it('allows up to the limit within the window, then frees up as hits age out', () => {
    const window = new RateWindow(2, 1000)
    window.record('a', 0)
    window.record('a', 100)
    expect(window.allows('a', 200)).toBe(false)
    expect(window.allows('b', 200)).toBe(true)
    expect(window.allows('a', 1001)).toBe(true)
  })

  it('treats a limit of 0 as no limit', () => {
    const window = new RateWindow(0, 1000)
    for (let i = 0; i < 100; i++) window.record('a', i)
    expect(window.allows('a', 100)).toBe(true)
  })
})

describe('DailyUsage', () => {
  it('counts replies and tokens and reports which budget ran out', async () => {
    const saved: unknown[] = []
    const usage = new DailyUsage(async (counts) => void saved.push(counts))
    await usage.add(10)
    await usage.add(15)
    expect(usage.current()).toMatchObject({ replies: 2, tokens: 25 })
    expect(usage.exhausted({ replies: 2, tokens: 0 })).toBe('replies')
    expect(usage.exhausted({ replies: 0, tokens: 20 })).toBe('tokens')
    expect(usage.exhausted({ replies: 0, tokens: 0 })).toBeUndefined()
    expect(saved).toHaveLength(2)
  })

  it('keeps today\'s saved counts and drops older ones', () => {
    const usage = new DailyUsage(async () => {})
    usage.load({ day: '2000-01-01', replies: 99, tokens: 99 })
    expect(usage.current()).toMatchObject({ replies: 0, tokens: 0 })
    usage.load({ day: localDay(), replies: 3, tokens: 40 })
    expect(usage.current()).toMatchObject({ replies: 3, tokens: 40 })
  })
})
