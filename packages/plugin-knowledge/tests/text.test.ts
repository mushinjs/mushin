import { describe, expect, it } from 'vitest'
import { candidateText, parseCandidates, transcript } from '../src/learn'
import { chunkText, extractText, formatOf, htmlToText } from '../src/text'

describe('chunkText', () => {
  it('keeps heading paths as titles and joins short paragraphs', () => {
    const chunks = chunkText('# 群规\n\n欢迎。\n\n## 广告\n\n禁止发广告。\n\n违者踢出。\n\n## 发言\n\n友善发言。', { size: 500, overlap: 0 }, '文档')
    expect(chunks).toEqual([
      { title: '群规', text: '欢迎。' },
      { title: '群规 > 广告', text: '禁止发广告。\n\n违者踢出。' },
      { title: '群规 > 发言', text: '友善发言。' },
    ])
  })

  it('splits long text by sentence with an overlap', () => {
    const text = Array.from({ length: 30 }, (_, index) => `这是第${index + 1}句话，用来测试切分。`).join('')
    const chunks = chunkText(text, { size: 100, overlap: 20 }, '长文')
    expect(chunks.length).toBeGreaterThan(3)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(130)
    expect(chunks[0].title).toBe('长文')
    // The second chunk starts with the end of the first.
    expect(chunks[1].text.startsWith(`${chunks[0].text.slice(-20)}…`)).toBe(true)
  })

  it('ignores headings inside code blocks', () => {
    const chunks = chunkText('# 用法\n\n```sh\n# not a heading\nls\n```', { size: 500, overlap: 0 })
    expect(chunks).toEqual([{ title: '用法', text: '```sh\n# not a heading\nls\n```' }])
  })
})

describe('documents', () => {
  it('knows formats by extension', () => {
    expect(formatOf('群规.MD')).toBe('md')
    expect(formatOf('page.htm')).toBe('html')
    expect(formatOf('a.docx')).toBe('docx')
    expect(formatOf('image.png')).toBeUndefined()
  })

  it('reads HTML as text with headings', () => {
    const page = htmlToText('<html><head><title>FAQ &amp; 帮助</title><style>p{}</style></head><body><nav>menu</nav><h2>退款</h2><p>七天内可以<b>退款</b>。</p><ul><li>一</li><li>二</li></ul><script>x()</script></body></html>')
    expect(page.title).toBe('FAQ & 帮助')
    expect(page.text).toBe('## 退款\n\n七天内可以退款。\n\n- 一\n- 二')
  })

  it('reads text files and tells how to read PDFs without the package', async () => {
    expect((await extractText('txt', new TextEncoder().encode('﻿a\r\nb'))).text).toBe('a\nb')
    await expect(extractText('docx', new Uint8Array([1, 2]))).rejects.toThrow(/mammoth/)
  })
})

describe('learning', () => {
  it('writes the chat as name: text lines', () => {
    expect(transcript([
      { direction: 'in', user: { id: '1', name: '小明' }, text: '服务器\n几点维护？' },
      { direction: 'out', user: { id: 'bot' }, text: '每周四 8 点' },
      { direction: 'in', user: { id: '2' }, text: '  ' },
    ], 'Mimi')).toBe('小明: 服务器 几点维护？\nMimi: 每周四 8 点')
  })

  it('reads the model\'s JSON, fenced or not', () => {
    expect(parseCandidates('```json\n[{"question":"几点维护？","answer":"每周四 8 点"},{"question":"几点维护？","answer":"dup"},{"question":"","answer":"x"}]\n```'))
      .toEqual([{ question: '几点维护？', answer: '每周四 8 点' }])
    expect(parseCandidates('没有值得记住的内容')).toEqual([])
    expect(candidateText({ question: 'Q', answer: 'A' })).toBe('问：Q\n答：A')
  })
})
