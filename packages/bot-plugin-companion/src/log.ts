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

/** Forgets a bot's log, when the plugin stops on it. */
export function dropDecisions(botId: string) {
  logs.delete(botId)
}
