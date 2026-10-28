import { describe, expect, it } from 'vitest'
import { normalize, passages, SearchIndex, tokenize } from '../src/search'

describe('tokenize', () => {
  it('splits CJK text into pairs and keeps Latin words', () => {
    expect(tokenize('能发广告吗')).toEqual(['能发', '发广', '广告', '告吗'])
    expect(tokenize('NapCat 的 WebSocket 端口是3001')).toEqual(['napcat', '的', 'websocket', '端口', '口是', '3001'])
    expect(tokenize('Ｈｅｌｌｏ，世界！')).toEqual(['hello', '世界'])
  })
})

describe('SearchIndex', () => {
  const chunks = [
    { id: 'a', doc: 'd', title: '群规 > 广告', text: '群里禁止发广告和推广链接，违者踢出。' },
    { id: 'b', doc: 'd', title: '群规 > 发言', text: '请友善发言，不要刷屏。' },
    { id: 'c', doc: 'e', title: 'NapCat', text: 'NapCat 的正向 WebSocket 默认端口是 3001。' },
  ]

  it('finds passages by words and fuses the two lists', () => {
    const index = new SearchIndex(chunks)
    const hits = index.search('能发广告吗', undefined, { topK: 2 })
    expect(hits[0]).toMatchObject({ id: 'a', ranks: { keyword: 1 } })
    expect(hits[0].coverage).toBe(0.5)
    expect(index.search('websocket 端口', undefined)[0].id).toBe('c')
    expect(index.search('完全无关的问题', undefined, { minScore: 0.3 })).toEqual([])
  })

  it('uses vectors when chunks and the question have them', () => {
    const withVectors = chunks.map((chunk, index) => ({ ...chunk, vector: normalize([index === 1 ? 1 : 0, index === 1 ? 0 : 1, 0]) }))
    const index = new SearchIndex(withVectors)
    expect(index.embedded).toBe(3)
    // No word in common with chunk b, but the closest by meaning.
    const hits = index.search('礼貌', normalize([1, 0, 0]), { topK: 1 })
    expect(hits[0]).toMatchObject({ id: 'b', similarity: 1, coverage: 0, score: 1, ranks: { vector: 1 } })
  })

  it('updates when chunks change', () => {
    const index = new SearchIndex(chunks)
    index.remove('a')
    expect(index.search('广告', undefined)).toEqual([])
    index.add({ id: 'a', doc: 'd', title: '', text: '广告请发到公告区' })
    expect(index.search('广告', undefined)[0].id).toBe('a')
    expect(index.size).toBe(3)
  })

  it('links similar chunks for the map', () => {
    const index = new SearchIndex([
      { id: 'x', doc: 'd', title: '', text: '退款流程：联系客服申请退款' },
      { id: 'y', doc: 'd', title: '', text: '申请退款需要联系客服' },
      { id: 'z', doc: 'd', title: '', text: '今天天气晴朗' },
    ])
    const { edges, byVector } = index.links({ minSimilarity: 0.2 })
    expect(byVector).toBe(false)
    expect(edges).toEqual([{ source: 'x', target: 'y', similarity: expect.any(Number) }])
  })

  it('numbers passages for the model', () => {
    expect(passages([{ title: 'A', text: 'one' }, { title: '', docTitle: 'Doc', text: 'two' }])).toBe('[1] A\none\n\n[2] Doc\ntwo')
  })
})
