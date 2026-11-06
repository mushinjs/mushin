import { type Context, z } from '@mushin/core'
import type { Decision } from './mind'

/** Decisions kept per bot, newest last. */
export const LOG_SIZE = 300

export interface LoggedDecision extends Decision {
  channel: { type: 'group' | 'private'; id: string }
}

const logs = new Map<string, LoggedDecision[]>()

/** Adds a decision to a bot's log. */
export function logDecision(botId: string, decision: LoggedDecision) {
  const list = logs.get(botId) ?? []
  list.push(decision)
  if (list.length > LOG_SIZE) list.splice(0, list.length - LOG_SIZE)
  logs.set(botId, list)
}

/** A bot's recent decisions, newest first. */
export function decisionsOf(botId: string, options: { channel?: string; limit?: number } = {}) {
  const list = (logs.get(botId) ?? []).filter((item) => !options.channel || item.channel.id === options.channel)
  return list.slice(-(options.limit ?? 50)).reverse()
}

// The plugin loads once per bot, but its action is defined once: by one of the bots running it,
// handed to another when that one stops.
const hosts = new Set<Context>()
let host: { ctx: Context; dispose: () => void } | undefined

function adopt(ctx: Context) {
  const dispose = ctx.actions.define({
    name: 'companion.decisions',
    description: 'Recent decisions of the companion chat plugin on a bot, newest first: when it looked at a chat, how interested it was, whether it replied, waited or stayed quiet and why, and what it sent.',
    risk: 'read',
    input: z.object({
      bot: z.string().describe('Bot id from bots.list'),
      channel: z.string().optional().describe('Only this group or private chat id'),
      limit: z.number().int().min(1).max(LOG_SIZE).optional().describe('At most this many; default 50'),
    }),
    handler: ({ bot, channel, limit }) => decisionsOf(bot, { channel, limit }),
  })
  host = { ctx, dispose }
}

/** Keeps the decisions action defined while any bot runs the plugin. */
export function shareDecisionsAction(ctx: Context) {
  hosts.add(ctx)
  if (!host) adopt(ctx)
  ctx.effect(() => () => {
    hosts.delete(ctx)
    logs.delete(ctx.bot.id)
    if (host?.ctx !== ctx) return
    host.dispose()
    host = undefined
    const next = hosts.values().next().value
    if (next) adopt(next)
  }, 'companion.decisions')
}
