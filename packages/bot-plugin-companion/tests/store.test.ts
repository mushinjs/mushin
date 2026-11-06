import { tmpdir } from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
import { Actions, Context } from '@mushin/core'
import * as database from '@mushin/plugin-database'
import { DatabaseStore, defineTables } from '../src/database'
import { InMemoryStore, type MemoryItem, type MemoryStore, type PersonCard } from '../src/store'

const fibers: { dispose(): unknown }[] = []
afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose()
})

async function databaseStore() {
  const ctx = new Context()
  ctx.baseDir = tmpdir()
  await ctx.plugin(Actions)
  fibers.push(ctx.plugin(database, { driver: 'memory', path: 'data/mushin.db' }))
  return new Promise<MemoryStore>((resolve) => {
    ctx.inject(['model', 'database'], (ctx) => {
      defineTables(ctx)
      resolve(new DatabaseStore(ctx))
    })
  })
}

const card = (user: string, patch: Partial<PersonCard> = {}): PersonCard => ({
  id: `b:${user}`, bot: 'b', user, name: `u${user}`, impression: '', facts: [], affinity: 0, seen: 1, updatedAt: 1, ...patch,
})
const memory = (id: string, people: string[], patch: Partial<MemoryItem> = {}): MemoryItem => ({
  id, bot: 'b', chat: 'group:500', text: `memory ${id}`, people, topic: '', recalls: 0, createdAt: 1, recalledAt: 0, ...patch,
})

for (const [label, make] of [['in memory', async () => new InMemoryStore()], ['in the database', databaseStore]] as const) {
  describe(`memory store ${label}`, () => {
    it('keeps people, memories and summaries per bot and chat', async () => {
      const store = await make()
      await store.savePeople([card('1', { impression: '爱打游戏', facts: ['在备考'] }), card('2'), card('3', { bot: 'other', id: 'other:3' })])
      expect((await store.people('b', ['1', '3'])).map((item) => item.impression)).toEqual(['爱打游戏'])
      expect((await store.people('b', ['1']))[0].facts).toEqual(['在备考'])
      await store.addMemories([memory('m1', ['1'], { vector: [0.1, 0.2] }), memory('m2', ['2']), memory('m3', ['1'], { chat: 'group:600' })])
      expect((await store.memories('b', 'group:500')).map((item) => item.id).sort()).toEqual(['m1', 'm2'])
      expect((await store.memories('b', 'group:500')).find((item) => item.id === 'm1')?.vector).toEqual([0.1, 0.2])
      await store.touch(['m1'], 99)
      expect((await store.memories('b', 'group:500')).find((item) => item.id === 'm1')).toMatchObject({ recalls: 1, recalledAt: 99 })
      await store.saveSummary({ id: 'b:group:500', bot: 'b', chat: 'group:500', summary: '聊了晚饭', until: 5, updatedAt: 5 })
      expect(await store.summary('b', 'group:500')).toMatchObject({ summary: '聊了晚饭', until: 5 })
      expect(await store.summary('b', 'group:600')).toBeUndefined()
    })

    it('forgets a person and the memories about them, and removes one memory', async () => {
      const store = await make()
      await store.savePeople([card('1'), card('2')])
      await store.addMemories([memory('a', ['1']), memory('b', ['1', '2']), memory('c', ['2'])])
      expect(await store.forget('b', '1')).toBe(2)
      expect((await store.allPeople('b')).map((item) => item.user)).toEqual(['2'])
      expect((await store.allMemories('b')).map((item) => item.id)).toEqual(['c'])
      expect(await store.removeMemory('b', 'c')).toBe(true)
      expect(await store.removeMemory('b', 'c')).toBe(false)
    })
  })
}
