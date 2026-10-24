import { type ChannelInfo, type Context, field, randomId, type Segment, seg, z } from '@mushin/core'
import type { AdapterType, Bot } from '@mushin/plugin-bots'

export const SELF_ID = 'demo-bot'

export const AdapterConfig = z.object({
  userName: z.string().min(1).default('Demo user').meta(field('Test user name', 'Who the simulated messages come from', {
    'zh-CN': { title: '测试用户昵称', description: '模拟消息的发送者' },
  })),
  userId: z.string().min(1).default('10001').meta(field('Test user id', undefined, { 'zh-CN': { title: '测试用户 ID' } })),
  groupId: z.string().min(1).default('demo').meta(field('Group id', 'Id of the simulated group chat', {
    'zh-CN': { title: '群号', description: '模拟群聊的 ID' },
  })),
  mirror: z.boolean().default(true).meta(field(
    'Replay dashboard messages as the test user',
    'Text you send from the live conversation view is then received by the bot as if the test user wrote it. Start with "@" to mention the bot.',
    { 'zh-CN': { title: '把控制台消息当作测试用户发送', description: '在实时对话里发出的文字会被机器人当作测试用户发来的消息处理；以「@」开头表示 @ 机器人。' } },
  )),
  greet: z.boolean().default(true).meta(field('Say /help on first start', 'The test user sends /help when the bot has no messages yet, so the chats show up', {
    'zh-CN': { title: '首次启动时发送 /help', description: '机器人还没有消息时，测试用户先发一条 /help，会话列表里就有内容了' },
  })),
})

export type AdapterConfig = z.infer<typeof AdapterConfig>

export interface SimulatedMessage {
  text: string
  private?: boolean
  userName?: string
  userId?: string
}

/** A leading "@" (or "@name ") becomes a mention of the bot. */
function toIncoming(text: string): Segment[] {
  const mention = /^@\S*\s*/.exec(text)
  if (!mention) return [seg.text(text)]
  const rest = text.slice(mention[0].length)
  return [seg.at(SELF_ID), ...(rest ? [seg.text(` ${rest}`)] : [])]
}

/** Feeds a made-up message from the test user into a sandbox bot. */
export function simulate(bot: Bot, config: AdapterConfig, message: SimulatedMessage) {
  const user = { id: message.userId ?? config.userId, name: message.userName ?? config.userName }
  const channel: ChannelInfo = message.private
    ? { type: 'private', id: user.id, name: user.name }
    : { type: 'group', id: config.groupId, name: 'Demo group' }
  // Not awaited: a flow may wait for the next message, which arrives through another call.
  bot.receive({ messageId: randomId(6), channel, user, segments: toIncoming(message.text) }).catch(() => {})
}

/** Sandbox adapter: always online, sends go nowhere, and the dashboard plays the test user. */
const SandboxPlugin = {
  name: 'demo-sandbox',
  inject: ['bot', 'bots'],
  apply(ctx: Context, raw: AdapterConfig) {
    const config = AdapterConfig.parse(raw ?? {})
    const bot = ctx.bot
    const logger = ctx.logger('demo')
    ctx.effect(() => {
      bot.setSelf(SELF_ID, bot.record.name)
      bot.setStatus('online')
      return () => {}
    }, 'demo sandbox status')
    bot.useTransport({
      send: async (channel, segments) => {
        logger.debug('to %s:%s: %o', channel.type, channel.id, segments)
        return { messageId: randomId(6) }
      },
      call: async (action) => {
        logger.debug('API call %s ignored in the sandbox', action)
        return {}
      },
    })

    if (config.mirror) {
      ctx.on('bots/message', (record) => {
        if (record.botId !== bot.id || record.direction !== 'out' || record.source?.kind !== 'manual') return
        const text = record.segments.map((s) => (s.type === 'text' ? s.data.text : '')).join('').trim()
        if (!text) return
        setTimeout(() => simulate(bot, config, { text, private: record.channel.type === 'private' }), 50)
      })
    }

    if (config.greet) {
      const timer = setTimeout(async () => {
        const history = await ctx.bots.messages(bot.id, { limit: 1 }).catch(() => [])
        if (!history.length) simulate(bot, config, { text: '/help' })
      }, 200)
      ctx.effect(() => () => clearTimeout(timer), 'demo greeting')
    }
    logger.info('sandbox ready; test user %s (%s)', config.userName, config.userId)
  },
}

export const sandboxAdapter: AdapterType<AdapterConfig> = {
  id: 'demo',
  displayName: { en: 'Demo sandbox', 'zh-CN': '演示沙盒' },
  config: AdapterConfig,
  segments: ['text', 'at', 'face', 'reply', 'image'],
  plugin: SandboxPlugin,
}
