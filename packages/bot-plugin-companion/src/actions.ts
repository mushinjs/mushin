import { type Context, MushinError, z } from '@mushin/core'
import { decisionsOf, dropDecisions, LOG_SIZE } from './log'
import type { MemoryStore } from './store'

// The plugin loads once per bot, but its actions are defined once: by one of the bots running it,
// handed to another when that one stops.
const hosts = new Set<Context>()
const stores = new Map<string, () => MemoryStore>()
let host: { ctx: Context; dispose: () => void } | undefined

const botField = z.string().describe('Bot id from bots.list')

function storeOf(bot: string) {
  const store = stores.get(bot)
  if (!store) throw new MushinError('not_found', `The companion plugin is not running on bot "${bot}"`)
  return store()
}

function adopt(ctx: Context) {
  const disposers = [
    ctx.actions.define({
      name: 'companion.decisions',
      description: 'Recent decisions of the companion chat plugin on a bot, newest first: when it looked at a chat, how interested it was, whether it replied, waited or stayed quiet and why, and what it sent.',
      risk: 'read',
      input: z.object({
        bot: botField,
        channel: z.string().optional().describe('Only this group or private chat id'),
        limit: z.number().int().min(1).max(LOG_SIZE).optional().describe('At most this many; default 50'),
      }),
      handler: ({ bot, channel, limit }) => decisionsOf(bot, { channel, limit }),
    }),
    ctx.actions.define({
      name: 'companion.people',
      description: 'What the companion on a bot thinks of the people it chats with: an impression, things they said about themselves, and how close it feels to them (-1 to 1). Closest first.',
      risk: 'read',
      input: z.object({ bot: botField }),
      handler: async ({ bot }) => (await storeOf(bot).allPeople(bot)).sort((a, b) => b.affinity - a.affinity),
    }),
    ctx.actions.define({
      name: 'companion.memories',
      description: 'Things the companion on a bot remembers from its chats, newest first, without their embeddings.',
      risk: 'read',
      input: z.object({
        bot: botField,
        chat: z.string().optional().describe('Only this chat, as group:<id> or private:<id>'),
      }),
      handler: async ({ bot, chat }) => (await storeOf(bot).allMemories(bot, chat))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(({ vector, ...item }) => item),
    }),
    ctx.actions.define({
      name: 'companion.removeMemory',
      description: 'Deletes one thing the companion on a bot remembers.',
      risk: 'write',
      input: z.object({ bot: botField, id: z.string().describe('Memory id from companion.memories') }),
      handler: async ({ bot, id }) => {
        if (!await storeOf(bot).removeMemory(bot, id)) throw new MushinError('not_found', `No memory "${id}"`)
        return { ok: true }
      },
    }),
    ctx.actions.define({
      name: 'companion.forget',
      description: 'Makes the companion on a bot forget a person: their card and every memory about them.',
      risk: 'write',
      input: z.object({ bot: botField, user: z.string().describe('The person\'s user id, e.g. a QQ number') }),
      handler: async ({ bot, user }) => ({ memories: await storeOf(bot).forget(bot, user) }),
    }),
  ]
  host = { ctx, dispose: () => disposers.forEach((dispose) => dispose()) }
}

/** Keeps the companion's actions defined while any bot runs the plugin, and serves this bot's memories. */
export function shareActions(ctx: Context, store: () => MemoryStore) {
  const bot = ctx.bot.id
  hosts.add(ctx)
  stores.set(bot, store)
  if (!host) adopt(ctx)
  ctx.effect(() => () => {
    hosts.delete(ctx)
    stores.delete(bot)
    dropDecisions(bot)
    if (host?.ctx !== ctx) return
    host.dispose()
    host = undefined
    const next = hosts.values().next().value
    if (next) adopt(next)
  }, 'companion actions')
}
