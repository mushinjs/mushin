/** What the companion remembers: people, things that happened, and a running summary of each chat. */

/** The bot's impression of one person, shared by every chat on the bot. */
export interface PersonCard {
  /** `<bot>:<user>` */
  id: string
  bot: string
  user: string
  name: string
  /** One or two sentences: who they are to the bot. */
  impression: string
  /** Things they said about themselves, newest last. */
  facts: string[]
  /** From -1 (dislikes) to 1 (close friend). */
  affinity: number
  /** How many summaries mentioned them. */
  seen: number
  updatedAt: number
}

/** Something that happened in a chat, worth recalling later. */
export interface MemoryItem {
  id: string
  bot: string
  /** `group:<id>` or `private:<id>` */
  chat: string
  text: string
  /** User ids the memory is about. */
  people: string[]
  topic: string
  vector?: number[]
  recalls: number
  createdAt: number
  recalledAt: number
}

/** The running summary of a chat and how far it has read. */
export interface ChatSummary {
  /** `<bot>:<chat>` */
  id: string
  bot: string
  chat: string
  summary: string
  /** Timestamp of the newest message the summary covers. */
  until: number
  updatedAt: number
}

export interface MemoryStore {
  people(bot: string, users: string[]): Promise<PersonCard[]>
  savePeople(cards: PersonCard[]): Promise<void>
  memories(bot: string, chat: string): Promise<MemoryItem[]>
  addMemories(items: MemoryItem[]): Promise<void>
  /** Marks memories as recalled now. */
  touch(ids: string[], at: number): Promise<void>
  summary(bot: string, chat: string): Promise<ChatSummary | undefined>
  saveSummary(summary: ChatSummary): Promise<void>
  /** Removes a person's card and the memories about them; returns how many memories went. */
  forget(bot: string, user: string): Promise<number>
  /** For the actions: a bot's people, and its memories of one chat or all. */
  allPeople(bot: string): Promise<PersonCard[]>
  allMemories(bot: string, chat?: string): Promise<MemoryItem[]>
  removeMemory(bot: string, id: string): Promise<boolean>
}

export const personId = (bot: string, user: string) => `${bot}:${user}`

/** Keeps everything in memory; used without the database plugin, and in tests. */
export class InMemoryStore implements MemoryStore {
  private cards = new Map<string, PersonCard>()
  private items = new Map<string, MemoryItem>()
  private summaries = new Map<string, ChatSummary>()

  async people(bot: string, users: string[]) {
    return users.map((user) => this.cards.get(personId(bot, user))).filter((card): card is PersonCard => !!card).map((card) => ({ ...card }))
  }

  async savePeople(cards: PersonCard[]) {
    for (const card of cards) this.cards.set(card.id, { ...card })
  }

  async memories(bot: string, chat: string) {
    return [...this.items.values()].filter((item) => item.bot === bot && item.chat === chat).map((item) => ({ ...item }))
  }

  async addMemories(items: MemoryItem[]) {
    for (const item of items) this.items.set(item.id, { ...item })
  }

  async touch(ids: string[], at: number) {
    for (const id of ids) {
      const item = this.items.get(id)
      if (item) Object.assign(item, { recalls: item.recalls + 1, recalledAt: at })
    }
  }

  async summary(bot: string, chat: string) {
    const summary = this.summaries.get(`${bot}:${chat}`)
    return summary && { ...summary }
  }

  async saveSummary(summary: ChatSummary) {
    this.summaries.set(summary.id, { ...summary })
  }

  async forget(bot: string, user: string) {
    this.cards.delete(personId(bot, user))
    let count = 0
    for (const [id, item] of this.items) {
      if (item.bot === bot && item.people.includes(user)) {
        this.items.delete(id)
        count++
      }
    }
    return count
  }

  async allPeople(bot: string) {
    return [...this.cards.values()].filter((card) => card.bot === bot).map((card) => ({ ...card }))
  }

  async allMemories(bot: string, chat?: string) {
    return [...this.items.values()].filter((item) => item.bot === bot && (!chat || item.chat === chat)).map((item) => ({ ...item }))
  }

  async removeMemory(bot: string, id: string) {
    const item = this.items.get(id)
    if (!item || item.bot !== bot) return false
    return this.items.delete(id)
  }
}
