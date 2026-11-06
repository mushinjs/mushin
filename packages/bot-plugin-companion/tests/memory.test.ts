import { describe, expect, it, vi } from 'vitest'
import { DIGEST_EVERY } from '../src/digest'
import { Memory, recollectionText } from '../src/memory'
import { InMemoryStore } from '../src/store'
import { record, text } from './helpers'

const alice = { id: '1', name: '小明' }
const bob = { id: '2', name: '小红' }
const chat = 'group:500'

const answer = JSON.stringify({
  summary: '小明说猫生病了，小红在准备考研',
  memories: [{ text: '小明家的猫生病了', people: ['1'], topic: '宠物' }, { text: '小红打电话13800138000', people: ['2'], topic: '' }],
  people: [{ id: '1', impression: '爱猫的人', facts: ['养了只猫'], affinity: 0.1 }, { id: '3', impression: '不在聊天里', facts: [], affinity: 0.2 }],
})

function setup(options: { embed?: boolean } = {}) {
  const store = new InMemoryStore()
  const ask = vi.fn(async () => answer)
  const embed = options.embed ? vi.fn(async (texts: string[]) => texts.map(() => [1, 0])) : undefined
  const memory = new Memory({ bot: 'b', store, selfId: '99', selfName: '小助', ask, embed })
  return { store, ask, embed, memory }
}

const chatRecords = () => [
  record(alice, [text('我家猫生病了')]),
  record(bob, [text('我在准备考研')]),
  record({ id: '99', name: '小助' }, [text('早日康复')], { direction: 'out' }),
]

describe('Memory', () => {
  it('digests the chat into a summary, memories and people', async () => {
    const { store, ask, memory } = setup()
    const records = chatRecords()
    await memory.digest(chat, async () => records)
    expect(ask).toHaveBeenCalledOnce()
    const prompt = (ask.mock.calls[0] as any)[0][1].content
    expect(prompt).toContain('小明[1]：我家猫生病了')
    expect((await store.summary('b', chat))).toMatchObject({ summary: '小明说猫生病了，小红在准备考研', until: records.at(-1)!.timestamp })
    // The memory with a phone number is dropped.
    expect((await store.memories('b', chat)).map((item) => item.text)).toEqual(['小明家的猫生病了'])
    const cards = await store.allPeople('b')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ user: '1', name: '小明', impression: '爱猫的人', facts: ['养了只猫'], affinity: 0.1, seen: 1 })
  })

  it('reads only messages after the last digest', async () => {
    const { ask, memory } = setup()
    const records = chatRecords()
    await memory.digest(chat, async () => records)
    await memory.digest(chat, async () => records)
    expect(ask).toHaveBeenCalledOnce()
  })

  it('digests once enough messages arrive', async () => {
    const { ask, memory } = setup()
    const records = chatRecords()
    for (let index = 0; index < DIGEST_EVERY - 1; index++) memory.observe(chat, async () => records)
    expect(ask).not.toHaveBeenCalled()
    memory.observe(chat, async () => records)
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce())
  })

  it('embeds memories when it can', async () => {
    const { store, embed, memory } = setup({ embed: true })
    await memory.digest(chat, async () => chatRecords())
    expect(embed).toHaveBeenCalledWith(['小明家的猫生病了'])
    expect((await store.memories('b', chat))[0].vector).toEqual([1, 0])
  })

  it('recalls the summary, the people talking and memories that fit', async () => {
    const { store, memory } = setup()
    await memory.digest(chat, async () => chatRecords())
    const recent = [record(alice, [text('猫好多了，不生病了')])]
    const recollection = await memory.recall(chat, recent)
    expect(recollection.summary).toBe('小明说猫生病了，小红在准备考研')
    expect(recollection.people.map((card) => card.user)).toEqual(['1'])
    expect(recollection.memories.map((item) => item.text)).toEqual(['小明家的猫生病了'])
    expect((await store.memories('b', chat))[0].recalls).toBe(1)

    const textBlock = recollectionText(recollection)
    expect(textBlock).toContain('之前聊过的：小明说猫生病了')
    expect(textBlock).toContain('- 小明[1]：爱猫的人；养了只猫')
    expect(textBlock).toContain('- 小明家的猫生病了')
  })

  it('renders nothing when there is nothing to remember', () => {
    expect(recollectionText({ people: [], memories: [] })).toBe('')
    expect(recollectionText(undefined)).toBe('')
  })
})
