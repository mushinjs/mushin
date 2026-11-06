import type { Context } from '@mushin/core'
import type {} from '@mushin/plugin-database'
import { type ChatSummary, type MemoryItem, type MemoryStore, type PersonCard, personId } from './store'

declare module 'minato' {
  interface Tables {
    companion_person: PersonCard
    companion_memory: MemoryItem
    companion_summary: ChatSummary
  }
}

/** Declares the companion's tables; once per instance is enough, but repeating it is harmless. */
export function defineTables(ctx: Context) {
  ctx.model.extend('companion_person', {
    id: 'string', bot: 'string', user: 'string', name: 'string', impression: 'text', facts: 'json',
    affinity: 'double', seen: 'unsigned', updatedAt: 'double',
  }, { primary: 'id', indexes: [['bot']] })
  ctx.model.extend('companion_memory', {
    id: 'string', bot: 'string', chat: 'string', text: 'text', people: 'json', topic: 'string', vector: 'json',
    recalls: 'unsigned', createdAt: 'double', recalledAt: 'double',
  }, { primary: 'id', indexes: [['bot', 'chat']] })
  ctx.model.extend('companion_summary', {
    id: 'string', bot: 'string', chat: 'string', summary: 'text', until: 'double', updatedAt: 'double',
  }, { primary: 'id' })
}

/** Keeps memories in the database plugin's tables, so they survive restarts. */
export class DatabaseStore implements MemoryStore {
  constructor(private ctx: Context) {}

  private get db() {
    return this.ctx.database
  }

  people(bot: string, users: string[]) {
    if (!users.length) return Promise.resolve([])
    return this.db.get('companion_person', { id: users.map((user) => personId(bot, user)) })
  }

  async savePeople(cards: PersonCard[]) {
    if (cards.length) await this.db.upsert('companion_person', cards)
  }

  memories(bot: string, chat: string) {
    return this.db.get('companion_memory', { bot, chat })
  }

  async addMemories(items: MemoryItem[]) {
    if (items.length) await this.db.upsert('companion_memory', items)
  }

  async touch(ids: string[], at: number) {
    if (!ids.length) return
    const rows = await this.db.get('companion_memory', { id: ids })
    await this.db.upsert('companion_memory', rows.map((row) => ({ ...row, recalls: row.recalls + 1, recalledAt: at })))
  }

  async summary(bot: string, chat: string) {
    const [row] = await this.db.get('companion_summary', { id: `${bot}:${chat}` })
    return row
  }

  async saveSummary(summary: ChatSummary) {
    await this.db.upsert('companion_summary', [summary])
  }

  async forget(bot: string, user: string) {
    await this.db.remove('companion_person', { id: personId(bot, user) })
    const about = (await this.db.get('companion_memory', { bot })).filter((item) => item.people.includes(user))
    if (about.length) await this.db.remove('companion_memory', { id: about.map((item) => item.id) })
    return about.length
  }

  allPeople(bot: string) {
    return this.db.get('companion_person', { bot })
  }

  allMemories(bot: string, chat?: string) {
    return this.db.get('companion_memory', chat ? { bot, chat } : { bot })
  }

  async removeMemory(bot: string, id: string) {
    const [row] = await this.db.get('companion_memory', { id, bot })
    if (!row) return false
    await this.db.remove('companion_memory', { id })
    return true
  }
}
