import type { ChannelInfo, Context, MessageRecord, Segment } from '@mushinjs/core'
import type {} from '@mushinjs/plugin-bots'
import type {} from '@mushinjs/plugin-flows'
import type {} from '@mushinjs/plugin-personas'
import type {} from '@mushinjs/plugin-providers'
import { Config } from './config'
import { DatabaseStore, defineTables } from './database'
import { shareActions } from './actions'
import { logDecision } from './log'
import { Memory } from './memory'
import { ChatMind, type PersonaInfo } from './mind'
import { inScope, remembers } from './scope'
import { InMemoryStore, type MemoryStore } from './store'

export * from './actions'
export * from './config'
export * from './database'
export * from './digest'
export * from './express'
export * from './interest'
export * from './log'
export * from './memory'
export * from './mind'
export * from './mood'
export * from './planner'
export * from './recall'
export * from './replier'
export * from './scope'
export * from './store'
export * from './transcript'

export const name = 'companion'
export const inject = ['bot', 'llm', 'actions']

export const PACKAGE = '@mushinjs/bot-plugin-companion'
const LLM_CHAT = '@mushinjs/bot-plugin-llm-chat'

/** Ahead of flows (10), so the companion sees every message; it always passes the message on. */
export const PRIORITY = 20

export { Config }

const keyOf = (channel: Pick<ChannelInfo, 'type' | 'id'>) => `${channel.type}:${channel.id}`

export function apply(ctx: Context, config: Config) {
  const bot = ctx.bot
  const logger = ctx.logger('companion')
  const minds = new Map<string, ChatMind>()

  // Memories live in the database when there is one, else only until the plugin stops.
  const fallback = new InMemoryStore()
  let store: MemoryStore = fallback
  ctx.inject(['model', 'database'], (ctx) => {
    defineTables(ctx)
    store = new DatabaseStore(ctx)
    ctx.effect(() => () => {
      store = fallback
    }, 'companion database store')
  })

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

  const memory = new Memory({
    bot: bot.id,
    get store() {
      return store
    },
    get selfId() {
      return bot.selfId
    },
    get selfName() {
      return bot.selfName ?? bot.record.name
    },
    ask: async (messages) => {
      const result = await ctx.llm.chat({
        provider: config.utilityProvider || config.plannerProvider || bot.record.provider,
        model: (config.utilityProvider ? config.utilityModel : config.utilityModel || config.plannerModel) || undefined,
        maxTokens: 1200,
        messages,
        signal: AbortSignal.timeout(90_000),
      })
      return result.text
    },
    embed: config.embedProvider && config.embedModel
      ? async (texts) => (await ctx.llm.embed({ provider: config.embedProvider, model: config.embedModel!, texts, signal: AbortSignal.timeout(30_000) })).vectors
      : undefined,
    onError: (error, chat) => logger.warn('memory of %s: %s', chat, (error as Error)?.message ?? error),
  })

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
        recall: async (records) => remembers(config, channel) ? memory.recall(key, records) : undefined,
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
    if (remembers(config, record.channel)) memory.observe(keyOf(record.channel), (limit) => history(record.channel, limit))
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

  shareActions(ctx, () => store)

  if (config.memory) {
    ctx.bot.command({ name: '忘掉我', aliases: ['forget-me'], description: '让机器人忘掉关于你的印象和记忆' }, async (session) => {
      const count = await store.forget(bot.id, session.user.id)
      await session.reply(count ? `好，关于你的事我都忘了（${count} 条）` : '好，关于你的印象我都忘了')
    })
  }

  ctx.effect(() => () => {
    for (const mind of minds.values()) mind.dispose()
    minds.clear()
  }, 'companion minds')
}
