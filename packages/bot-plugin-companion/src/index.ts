import type { ChannelInfo, Context, MessageRecord, Segment } from '@mushin/core'
import type {} from '@mushin/plugin-bots'
import type {} from '@mushin/plugin-flows'
import type {} from '@mushin/plugin-personas'
import type {} from '@mushin/plugin-providers'
import { Config } from './config'
import { ChatMind, type PersonaInfo } from './mind'
import { logDecision, shareDecisionsAction } from './log'
import { inScope } from './scope'

export * from './config'
export * from './database'
export * from './digest'
export * from './express'
export * from './interest'
export * from './log'
export * from './memory'
export * from './mind'
export * from './planner'
export * from './recall'
export * from './replier'
export * from './scope'
export * from './store'
export * from './transcript'

export const name = 'companion'
export const inject = ['bot', 'llm', 'actions']

export const PACKAGE = '@mushin/bot-plugin-companion'
const LLM_CHAT = '@mushin/bot-plugin-llm-chat'

/** Ahead of flows (10), so the companion sees every message; it always passes the message on. */
export const PRIORITY = 20

export { Config }

const keyOf = (channel: Pick<ChannelInfo, 'type' | 'id'>) => `${channel.type}:${channel.id}`

export function apply(ctx: Context, config: Config) {
  const bot = ctx.bot
  const logger = ctx.logger('companion')
  const minds = new Map<string, ChatMind>()

  const ignored = (record: MessageRecord) => record.direction !== 'in'
    || record.user.id === bot.selfId
    || config.ignoreUsers.includes(record.user.id)
    || !inScope(config, record.channel)

  const history = async (channel: ChannelInfo, limit: number) => {
    const records = await ctx.bots.messages(bot.id, { channel: channel.id, limit: limit * 2 })
    return records.filter((record) => record.channel.type === channel.type).slice(-limit)
  }

  const persona = (record: MessageRecord): PersonaInfo | undefined => {
    const found = ctx.get('personas')?.forSession(bot.id, { user: record.user, channel: record.channel })
    return found && { name: found.name, prompt: found.prompt, examples: found.examples, provider: found.provider, model: found.model }
  }

  const mindOf = (channel: ChannelInfo) => {
    const key = keyOf(channel)
    let mind = minds.get(key)
    if (!mind) {
      mind = new ChatMind({
        config,
        get selfId() {
          return bot.selfId
        },
        get name() {
          return bot.selfName ?? bot.record.name
        },
        history: (limit) => history(channel, limit),
        persona,
        chat: async (role, messages, persona) => {
          const planner = role === 'planner'
          const result = await ctx.llm.chat({
            provider: (planner ? config.plannerProvider : config.replyProvider || persona?.provider) || bot.record.provider,
            model: (planner ? config.plannerModel : config.replyModel || persona?.model) || undefined,
            maxTokens: planner ? 400 : 800,
            messages,
            signal: AbortSignal.timeout(45_000),
          })
          return { text: result.text, source: { ...result.source, plugin: PACKAGE, ...(persona?.name ? { persona: persona.name } : {}) } }
        },
        send: async (text, options) => {
          const segments: Segment[] = [...(options.quote ? [{ type: 'reply', data: { id: options.quote } }] : []), { type: 'text', data: { text } }]
          await bot.deliver(channel, { segments, text, source: options.source }, { plugin: PACKAGE })
        },
        onDecision: (decision) => {
          logDecision(bot.id, { ...decision, channel: { type: channel.type, id: channel.id } })
          logger.debug('%s: %s (%s)', key, decision.action, decision.plan?.reason ?? decision.interest.reasons.join(' '))
        },
      })
      minds.set(key, mind)
    }
    return mind
  }

  ctx.bot.middleware(async (session, next) => {
    const record = session.record
    // Platforms often give whole seconds, so time the message by its arrival, not its timestamp.
    const arrived = Date.now()
    await next()
    if (ignored(record) || session.command?.entry) return
    // Something else (a keyword flow, a command) already answered this message.
    const recent = await ctx.bots.messages(bot.id, { channel: record.channel.id, limit: 5 }).catch(() => [])
    const answered = recent.some((item) => item.direction === 'out' && item.channel.type === record.channel.type && item.timestamp >= arrived
      && !('plugin' in item.source && item.source.plugin === PACKAGE))
    if (answered) return
    mindOf(record.channel).push(record)
  }, { priority: PRIORITY })

  // In the chats it takes, the companion answers instead of the LLM chat flow.
  ctx.inject(['flows'], (ctx) => {
    ctx.flows.useFlowFilter((flow, { botId, session }) => botId === bot.id
      && flow.source?.kind === 'plugin' && flow.source.plugin === LLM_CHAT
      && inScope(config, session.channel) && !config.ignoreUsers.includes(session.user.id))
  })

  shareDecisionsAction(ctx)

  ctx.effect(() => () => {
    for (const mind of minds.values()) mind.dispose()
    minds.clear()
  }, 'companion minds')
}
