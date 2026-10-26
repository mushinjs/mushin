import { type Context, field, z } from '@mushin/core'
import type { Session } from '@mushin/plugin-bots'
import type { LlmMessage } from '@mushin/plugin-providers'
import type {} from '@mushin/plugin-storage'
import type { PersonaLike } from '@mushin/plugin-flows'
import { type DailyCounts, DailyUsage, RateWindow } from './limits'

export * from './limits'

export const name = 'llm-chat'
export const inject = ['bot', 'llm', 'storage']

export const Config = z.object({
  trigger: z.enum(['mention', 'always']).default('mention').meta(field(
    'When to reply',
    'mention: in groups, only when @-mentioned (private chats always get replies). always: every message.',
    { 'zh-CN': { title: '何时回复', description: 'mention：群聊中仅在被 @ 时回复（私聊总是回复）。always：回复每条消息。' } },
  )),
  systemPrompt: z.string().default('You are a friendly chat bot in a QQ chat. Keep replies short and natural, and answer in the language the user writes in.').meta(field(
    'System prompt',
    'Instructions given to the model before the conversation. When the bot has a persona (Personas plugin), the persona speaks and this is kept only if changed, as extra rules.',
    { 'zh-CN': { title: '系统提示词', description: '在对话开始前交给模型的指令。机器人有人格时（人格插件）由人格说话，这里只有改过时才作为补充规则保留。' } },
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

  // Where the bot may reply.
  privateChat: z.boolean().default(true).meta(field('Reply in private chats', 'Turn off to answer only in groups', {
    'zh-CN': { title: '回复私聊', description: '关闭后只在群聊中回复' },
  })),
  groups: z.array(z.string()).default([]).meta(field('Only these groups', 'Group ids to reply in; empty means every group', {
    'zh-CN': { title: '仅限这些群', description: '允许回复的群号；留空表示所有群' },
  })),
  ignoreUsers: z.array(z.string()).default([]).meta(field('Ignore users', 'User ids that never get a reply, such as other bots', {
    'zh-CN': { title: '忽略用户', description: '永远不回复的用户 QQ 号，例如其他机器人' },
  })),

  // How often it may reply.
  cooldown: z.number().min(0).default(3).meta(field('Chat cooldown (seconds)', 'Least time between two replies in the same chat; 0 means none', {
    'zh-CN': { title: '会话冷却（秒）', description: '同一会话中两次回复的最短间隔；0 表示不限制' },
  })),
  userLimit: z.number().int().min(0).default(5).meta(field('Replies per user', 'Most replies to one user within the window below; 0 means no limit', {
    'zh-CN': { title: '每人回复次数', description: '在下方时间窗口内最多回复同一用户的次数；0 表示不限制' },
  })),
  userWindow: z.number().min(1).default(60).meta(field('User window (seconds)', 'Length of the per-user window', {
    'zh-CN': { title: '每人时间窗口（秒）', description: '每人回复次数的统计时长' },
  })),
  limitNotice: z.string().default('').meta(field('Rate limit notice', 'Sent once to a user who hits the limit; empty stays silent', {
    'zh-CN': { title: '限流提示', description: '用户触发限流时发送一次的提示；留空则不提示' },
  })),

  // How much it may spend per day.
  dailyReplies: z.number().int().min(0).default(300).meta(field('Daily reply limit', 'Most LLM replies per day for this bot; 0 means no limit', {
    'zh-CN': { title: '每日回复上限', description: '此机器人每天最多的大模型回复次数；0 表示不限制' },
  })),
  dailyTokens: z.number().int().min(0).default(0).meta(field('Daily token budget', 'Most tokens per day for this bot, as reported by the provider; 0 means no limit', {
    'zh-CN': { title: '每日 Token 预算', description: '此机器人每天最多使用的 Token 数（以提供商报告为准）；0 表示不限制' },
  })),
  maxInputChars: z.number().int().min(50).default(1000).meta(field('Max message length', 'Longer messages are cut to this many characters before they reach the model', {
    'zh-CN': { title: '消息长度上限', description: '超过此字数的消息在发给模型前会被截断' },
  })),
})

type Config = z.infer<typeof Config>

const DEFAULT_PROMPT = Config.shape.systemPrompt.parse(undefined)
/** The plugin's own rules, kept after a persona's prompt. */
const CHAT_RULES = 'You are chatting in a QQ chat. Keep replies short and natural, and answer in the language the user writes in.'

/** The system prompt and example exchanges: the persona's, then the plugin's rules; the configured prompt without a persona. */
export function systemMessages(persona: PersonaLike | undefined, systemPrompt: string): LlmMessage[] {
  if (!persona) return [{ role: 'system', content: systemPrompt }]
  const rules = systemPrompt && systemPrompt !== DEFAULT_PROMPT ? systemPrompt : CHAT_RULES
  return [
    { role: 'system', content: `${persona.prompt}\n\n${rules}` },
    ...(persona.examples ?? []).flatMap((example): LlmMessage[] => [
      { role: 'user', content: example.user },
      { role: 'assistant', content: example.assistant },
    ]),
  ]
}

/** The persona plugin, when it runs: its persona for this chat. */
interface PersonaSource {
  forSession(botId: string, session: Pick<Session, 'user' | 'channel'>): PersonaLike | undefined
}

/** Why a message got no reply, for debug logs and tests. */
export type SkipReason = 'not-triggered' | 'private-off' | 'group-not-allowed' | 'ignored-user' | 'busy' | 'cooldown' | 'user-limit' | 'daily-replies' | 'daily-tokens'

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('llm-chat')
  // Per-channel rolling history, kept in memory only.
  const histories = new Map<string, LlmMessage[]>()
  const busy = new Set<string>()
  const lastReply = new Map<string, number>()
  const userRate = new RateWindow(config.userLimit, config.userWindow * 1000)
  const noticed = new RateWindow(1, config.userWindow * 1000)
  const storageKey = `llm-chat/${ctx.bot.id}`
  const usage = new DailyUsage((counts) => ctx.storage.set(storageKey, counts))
  const loaded = ctx.storage.get<DailyCounts>(storageKey).then((saved) => usage.load(saved), () => {})
  let budgetWarnedOn = ''

  const remember = (key: string, message: LlmMessage) => {
    if (config.historySize === 0) return
    const history = histories.get(key) ?? []
    history.push(message)
    if (history.length > config.historySize * 2) history.splice(0, history.length - config.historySize * 2)
    histories.set(key, history)
  }

  const clip = (text: string) => (text.length > config.maxInputChars ? `${text.slice(0, config.maxInputChars)}…` : text)

  /** Checks every guardrail; returns why not to reply, or nothing when a reply is allowed. */
  const check = (session: Session, key: string): SkipReason | undefined => {
    if (!session.text) return 'not-triggered'
    if (session.isDirect) {
      if (!config.privateChat) return 'private-off'
    } else {
      if (config.trigger === 'mention' && !session.mentioned) return 'not-triggered'
      if (config.groups.length && !config.groups.includes(session.channel.id)) return 'group-not-allowed'
    }
    if (config.ignoreUsers.includes(session.user.id)) return 'ignored-user'
    if (busy.has(key)) return 'busy'
    if (config.cooldown > 0 && Date.now() - (lastReply.get(key) ?? 0) < config.cooldown * 1000) return 'cooldown'
    if (!userRate.allows(session.user.id)) return 'user-limit'
    const spent = usage.exhausted({ replies: config.dailyReplies, tokens: config.dailyTokens })
    if (spent) return spent === 'replies' ? 'daily-replies' : 'daily-tokens'
  }

  ctx.bot.middleware(async (session, next) => {
    await loaded
    const key = `${session.channel.type}:${session.channel.id}`
    const speaker = session.user.name ?? session.user.id
    const text = clip(session.text)
    const userMessage: LlmMessage = { role: 'user', content: session.isDirect ? text : `${speaker}: ${text}` }

    const skip = check(session, key)
    if (skip) {
      // Unanswered group messages still give the model context for later replies.
      if (text && !session.isDirect) remember(key, userMessage)
      if (skip !== 'not-triggered') logger.debug('no reply in %s: %s', key, skip)
      if (skip === 'user-limit' && config.limitNotice && noticed.allows(session.user.id)) {
        noticed.record(session.user.id)
        await session.send(config.limitNotice)
      }
      if ((skip === 'daily-replies' || skip === 'daily-tokens') && budgetWarnedOn !== usage.current().day) {
        budgetWarnedOn = usage.current().day
        logger.warn('bot %s reached its daily %s limit; LLM replies pause until midnight', ctx.bot.record.name, skip === 'daily-replies' ? 'reply' : 'token')
      }
      return next()
    }

    busy.add(key)
    lastReply.set(key, Date.now())
    userRate.record(session.user.id)
    try {
      const persona = (ctx.get('personas') as PersonaSource | undefined)?.forSession(ctx.bot.id, session)
      const result = await ctx.llm.chat({
        provider: config.provider ?? persona?.provider ?? ctx.bot.record.provider,
        model: config.model ?? persona?.model,
        maxTokens: config.maxTokens,
        ...(persona?.temperature !== undefined ? { temperature: persona.temperature } : {}),
        messages: [
          ...systemMessages(persona, config.systemPrompt),
          ...(histories.get(key) ?? []),
          userMessage,
        ],
      })
      if (persona) result.source.persona = persona.name
      remember(key, userMessage)
      await usage.add(result.usage ? result.usage.inputTokens + result.usage.outputTokens : 0)
      if (!result.text.trim()) return
      remember(key, { role: 'assistant', content: result.text })
      // Passing the LLM result keeps its provenance: provider, model and latency show in the dashboard.
      await session.send(result)
    } catch (error) {
      logger.warn('reply failed: %s', error)
    } finally {
      busy.delete(key)
    }
  })
}
