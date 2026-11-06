import { describe, expect, it } from 'vitest'
import { BACKOFF, interestOf, Willingness } from '../src/interest'
import { record, text } from './helpers'

const base = { selfId: 'bot', aliases: ['小喵'], interests: ['原神', '猫'], talkValue: 0.5, before: [], now: Date.UTC(2026, 10, 6, 13) }
const user = { id: '1', name: 'A' }

describe('interestOf', () => {
  it('knows when the bot is spoken to', () => {
    expect(interestOf([record(user, [{ type: 'at', data: { qq: 'bot' } }, text('在吗')])], base).addressed).toBe(true)
    const own = record({ id: 'bot' }, [text('好')], { direction: 'out' })
    const reply = record(user, [{ type: 'reply', data: { id: own.messageId } }, text('真的？')])
    expect(interestOf([reply], { ...base, before: [own] }).addressed).toBe(true)
    expect(interestOf([record(user, [text('hi')], { channel: { type: 'private', id: '1' } })], base).addressed).toBe(true)
    expect(interestOf([record(user, [text('今天好热')])], base).addressed).toBe(false)
  })

  it('likes its name, its topics and questions more than small talk', () => {
    const plain = interestOf([record(user, [text('今天好热')])], base).score
    const named = interestOf([record(user, [text('小喵今天好热')])], base)
    const topic = interestOf([record(user, [text('原神更新了吗')])], base)
    expect(named.score).toBeGreaterThan(plain)
    expect(named.reasons).toContain('named')
    expect(topic.reasons).toEqual(expect.arrayContaining(['topic:原神', 'question']))
    expect(topic.score).toBeGreaterThan(plain)
  })

  it('scales with talkativeness, down to nothing', () => {
    const batch = [record(user, [text('小喵 原神')])]
    expect(interestOf(batch, { ...base, talkValue: 1 }).score).toBeCloseTo(interestOf(batch, base).score * 2)
    expect(interestOf(batch, { ...base, talkValue: 0 }).score).toBe(0)
  })
})

describe('Willingness', () => {
  const t0 = 1_000_000
  const interest = (score: number, addressed = false) => ({ score, addressed, reasons: [] })

  it('adds interest up, lets it fade, and always answers when addressed', () => {
    const will = new Willingness(1)
    expect(will.add(interest(0.6), t0)).toBe(false)
    expect(will.add(interest(0.6), t0 + 1000)).toBe(true)
    const fading = new Willingness(1)
    fading.add(interest(0.6), t0)
    expect(fading.add(interest(0.6), t0 + 120_000)).toBe(false)
    expect(new Willingness(1).add(interest(0, true), t0)).toBe(true)
  })

  it('backs off after staying quiet, doubling up to the cap, and starts over once it speaks', () => {
    const will = new Willingness(0.1)
    will.stayedQuiet(t0)
    expect(will.quietUntil).toBe(t0 + BACKOFF.base)
    expect(will.add(interest(5), t0 + 1000)).toBe(false)
    expect(will.add(interest(0, true), t0 + 1000)).toBe(true)
    for (let i = 0; i < 10; i++) will.stayedQuiet(t0)
    expect(will.quietUntil).toBe(t0 + BACKOFF.cap)
    will.spoke(t0)
    expect(will.add(interest(0.2), t0 + 1)).toBe(true)
  })
})
