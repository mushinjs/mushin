import { describe, expect, it } from 'vitest'
import { digestPrompt, mergePeople, newMemories, nextSummary, parseDigest } from '../src/digest'
import type { PersonCard } from '../src/store'

const known = new Set(['1', '2'])
const card = (user: string, patch: Partial<PersonCard> = {}): PersonCard => ({
  id: `b:${user}`, bot: 'b', user, name: `u${user}`, impression: '', facts: [], affinity: 0, seen: 0, updatedAt: 0, ...patch,
})

describe('digest', () => {
  it('shows the old summary, the people and the chat', () => {
    const prompt = digestPrompt({ summary: '聊了晚饭', people: [card('1', { name: 'A', impression: '爱吃', facts: ['在减肥'] })], transcript: '[#1 12:00] A[1]：hi' })
    expect(prompt).toContain('<summary>\n聊了晚饭\n</summary>')
    expect(prompt).toContain('A[1]：爱吃；在减肥')
    expect(prompt).toContain('A[1]：hi')
  })

  it('reads the answer, keeping known people and leaving private details out', () => {
    const digest = parseDigest(JSON.stringify({
      summary: '大家在约周末爬山',
      memories: [
        { text: 'A 说周六去爬山', people: ['1', '999'], topic: '爬山' },
        { text: 'B 的手机号是 13800138000', people: ['2'] },
      ],
      people: [
        { id: '1', impression: '爱运动', facts: ['在备考', '住址是某某小区'], affinity: 0.9 },
        { id: '999', impression: '路人' },
      ],
    }), known)!
    expect(digest.summary).toBe('大家在约周末爬山')
    expect(digest.memories).toEqual([{ text: 'A 说周六去爬山', people: ['1'], topic: '爬山' }])
    expect(digest.people).toEqual([{ id: '1', impression: '爱运动', facts: ['在备考'], affinity: 0.2 }])
    expect(parseDigest('not json', known)).toBeUndefined()
  })

  it('merges into person cards and makes memory rows and the next summary', () => {
    const digest = { summary: '', memories: [{ text: 'm', people: ['1'], topic: 't' }], people: [{ id: '1', impression: '', facts: ['养猫', '在备考'], affinity: 0.2 }, { id: '2', impression: '新来的', facts: [], affinity: 0 }] }
    const cards = mergePeople('b', [card('1', { impression: '老朋友', facts: ['在备考'], affinity: 0.95, seen: 3 })], digest, new Map([['2', 'B']]), 10)
    expect(cards[0]).toMatchObject({ impression: '老朋友', facts: ['养猫', '在备考'], affinity: 1, seen: 4, updatedAt: 10 })
    expect(cards[1]).toMatchObject({ id: 'b:2', name: 'B', impression: '新来的', seen: 1 })
    const rows = newMemories('b', 'group:500', digest, 10, [[1, 0]])
    expect(rows[0]).toMatchObject({ bot: 'b', chat: 'group:500', text: 'm', vector: [1, 0], recalls: 0 })
    expect(nextSummary('b', 'group:500', { id: 'x', bot: 'b', chat: 'group:500', summary: 'old', until: 1, updatedAt: 1 }, digest, 9, 10)).toMatchObject({ summary: 'old', until: 9 })
  })
})
