import { type Context, field, z } from '@mushin/core'
import type { Session } from '@mushin/plugin-bots'
import type { LlmMessage } from '@mushin/plugin-providers'

export const name = 'llm-chat'
export const inject = ['bot', 'llm']

export const Config = z.object({
  trigger: z.enum(['mention', 'always']).default('mention').meta(field(
    'When to reply',
    'mention: in groups, only when @-mentioned (private chats always get replies). always: every message.',
    { 'zh-CN': { title: '何时回复', description: 'mention：群聊中仅在被 @ 时回复（私聊总是回复）。always：回复每条消息。' } },
  )),
  systemPrompt: z.string().default('You are a friendly chat bot in a QQ chat. Keep replies short and natural, and answer in the language the user writes in.').meta(field(
    'System prompt',
    'Instructions given to the model before the conversation',
    { 'zh-CN': { title: '系统提示词', description: '在对话开始前交给模型的指令' } },
  )),
  provider: z.string().optional().meta(field('Provider', 'Provider id; empty uses the bot\'s or the global default', {
    'zh-CN': { title: '提供商', description: '提供商 id；留空使用机器人或全局默认' },
  })),
  model: z.string().optional().meta(field('Model', 'Model name; empty uses the provider\'s default', {
    'zh-CN': { title: '模型', description: '模型名称；留空使用提供商默认模型' },
  })),
  historySize: z.number().int().min(0).max(50).default(10).meta(field('History size', 'Earlier messages per chat to include as context', {
    'zh-CN': { title: '上下文条数', description: '每个会话作为上下文带上的历史消息数量' },
  })),
  maxTokens: z.number().int().min(64).max(64000).default(2000).meta(field('Max tokens', 'Upper bound for one reply, including any model reasoning', {
    'zh-CN': { title: '最大 Token 数', description: '单次回复的上限，包括模型的推理过程' },
  })),
})

type Config = z.infer<typeof Config>

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('llm-chat')
  // Per-channel rolling history, kept in memory only.
  const histories = new Map<string, LlmMessage[]>()

  const remember = (key: string, message: LlmMessage) => {
    if (config.historySize === 0) return
    const history = histories.get(key) ?? []
    history.push(message)
    if (history.length > config.historySize * 2) history.splice(0, history.length - config.historySize * 2)
    histories.set(key, history)
  }

  const shouldReply = (session: Session) => {
    if (!session.text) return false
    if (config.trigger === 'always' || session.isDirect) return true
    return session.mentioned
  }

  ctx.bot.middleware(async (session, next) => {
    const key = `${session.channel.type}:${session.channel.id}`
    const speaker = session.user.name ?? session.user.id
    if (!shouldReply(session)) {
      if (session.text && !session.isDirect) remember(key, { role: 'user', content: `${speaker}: ${session.text}` })
      return next()
    }
    const userMessage: LlmMessage = { role: 'user', content: session.isDirect ? session.text : `${speaker}: ${session.text}` }
    try {
      const result = await ctx.llm.chat({
        provider: config.provider ?? ctx.bot.record.provider,
        model: config.model,
        maxTokens: config.maxTokens,
        messages: [
          { role: 'system', content: config.systemPrompt },
          ...(histories.get(key) ?? []),
          userMessage,
        ],
      })
      remember(key, userMessage)
      if (!result.text.trim()) return
      remember(key, { role: 'assistant', content: result.text })
      // Passing the LLM result keeps its provenance: provider, model and latency show in the dashboard.
      await session.send(result)
    } catch (error) {
      logger.warn('reply failed: %s', error)
    }
  })
}
