import { describe, expect, it } from 'vitest'
import { cosine, recall, words } from '../src/recall'
import type { MemoryItem } from '../src/store'

const now = Date.UTC(2026, 10, 6)
const memory = (id: string, text: string, patch: Partial<MemoryItem> = {}): MemoryItem => ({
  id, bot: 'b', chat: 'group:500', text, people: [], topic: '', recalls: 0, createdAt: now, recalledAt: 0, ...patch,
})

describe('words', () => {
  it('pairs CJK characters and keeps Latin words', () => {
    expect([...words('明天考CET4')]).toEqual(['明天', '天考', 'cet4'])
    expect([...words('猫')]).toEqual(['猫'])
  })
})

describe('recall', () => {
  const items = [
    memory('cat', '小明说他家的猫生病了', { people: ['1'], topic: '宠物' }),
    memory('exam', '小红在准备考研', { people: ['2'], topic: '考试' }),
    memory('game', '大家约好周末一起打游戏', { topic: '游戏' }),
  ]

  it('finds memories that share words with the chat', () => {
    expect(recall(items, { text: '你家猫怎么样了，生病好了吗', people: [], now }).map((item) => item.id)).toEqual(['cat'])
  })

  it('leaves out memories with nothing in common', () => {
    expect(recall(items, { text: '今天天气不错', people: ['1'], now })).toEqual([])
  })

  it('prefers memories about the people present', () => {
    const both = [memory('a', '小明喜欢打游戏', { people: ['1'] }), memory('b', '小红喜欢打游戏', { people: ['2'] })]
    expect(recall(both, { text: '打游戏吗', people: ['2'], now })[0].id).toBe('b')
  })

  it('uses vectors when both sides have one', () => {
    const embedded = [memory('x', '无关', { vector: [1, 0] }), memory('y', '无关', { vector: [0, 1] })]
    expect(recall(embedded, { text: 'whatever', vector: [0.1, 1], people: [], now }).map((item) => item.id)).toEqual(['y'])
  })

  it('keeps at most the count asked for', () => {
    const many = Array.from({ length: 6 }, (_, index) => memory(`m${index}`, `一起打游戏${index}`))
    expect(recall(many, { text: '打游戏', people: [], now }, 2)).toHaveLength(2)
  })

  it('computes cosine similarity', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1)
    expect(cosine([1, 0], [0, 0])).toBe(0)
  })
})
