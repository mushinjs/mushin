import { describe, expect, it } from 'vitest'
import { asleep, CALM, Mood, MOOD_FADE } from '../src/mood'

const at = (hours: number, minutes = 0) => new Date(2026, 10, 6, hours, minutes).getTime()

describe('Mood', () => {
  it('keeps the named mood for a while, then calms down', () => {
    const mood = new Mood()
    expect(mood.current(0)).toBe(CALM)
    mood.set('开心', 1000)
    expect(mood.current(1000 + MOOD_FADE - 1)).toBe('开心')
    expect(mood.current(1000 + MOOD_FADE + 1)).toBe(CALM)
  })

  it('ignores empty or long moods', () => {
    const mood = new Mood()
    mood.set('烦', 0)
    mood.set('', 10)
    mood.set('我现在非常非常开心呀', 20)
    expect(mood.current(30)).toBe('烦')
  })
})

describe('asleep', () => {
  it('is off without quiet hours', () => {
    expect(asleep(undefined, at(3))).toBe(false)
    expect(asleep('nonsense', at(3))).toBe(false)
  })

  it('wraps past midnight', () => {
    expect(asleep('23:30-07:00', at(23, 45))).toBe(true)
    expect(asleep('23:30-07:00', at(6, 59))).toBe(true)
    expect(asleep('23:30-07:00', at(7))).toBe(false)
    expect(asleep('23:30-07:00', at(12))).toBe(false)
  })

  it('works within a day', () => {
    expect(asleep('13:00-14:00', at(13, 30))).toBe(true)
    expect(asleep('13:00-14:00', at(14))).toBe(false)
  })
})
