import { field, z } from '@mushin/core'

/** How long the companion waits for someone to finish typing before it reads what they said. */
export const DEBOUNCE = {
  fast: { quiet: 1200, max: 4000 },
  natural: { quiet: 2500, max: 8000 },
  steady: { quiet: 4500, max: 15000 },
} as const

export type DebounceMode = keyof typeof DEBOUNCE

const providerField = (en: string, zh: string) => z.string().optional().meta(field(en, 'Provider or model profile; empty uses the bot\'s', {
  'zh-CN': { title: zh, description: '提供商或配置方案；留空使用机器人的默认提供商' },
}, { choices: 'providers.choices' }))

const modelField = (en: string, zh: string) => z.string().optional().meta(field(en, 'Empty uses the provider\'s default model', {
  'zh-CN': { title: zh, description: '留空使用提供商的默认模型' },
}))

export const Config = z.object({
  groups: z.array(z.string()).default([]).meta(field('Only these groups', 'Group ids the companion chats in; empty means every group', {
    'zh-CN': { title: '仅限这些群', description: '拟人群聊生效的群号；留空表示所有群' },
  })),
  excludeGroups: z.array(z.string()).default([]).meta(field('Not in these groups', 'These groups keep the LLM chat flow', {
    'zh-CN': { title: '排除这些群', description: '这些群继续使用大模型对话流程' },
  })),
  privateChat: z.boolean().default(false).meta(field('Private chats', 'Also chat in private chats; there it answers every message', {
    'zh-CN': { title: '私聊', description: '私聊也用拟人方式；私聊里每条都会回' },
  })),
  aliases: z.array(z.string()).default([]).meta(field('Names', 'What people call the bot; a message that says one counts like a mention, but less', {
    'zh-CN': { title: '称呼', description: '群友对机器人的称呼；消息里提到时比普通消息更容易引起回复' },
  })),
  interests: z.array(z.string()).default([]).meta(field('Interests', 'Words for topics the bot likes to join in on', {
    'zh-CN': { title: '感兴趣的话题', description: '机器人更愿意参与的话题关键词' },
  })),
  talkValue: z.number().min(0).max(1).default(0.4).meta(field('Talkativeness', '0 only answers when mentioned, 1 joins in often', {
    'zh-CN': { title: '活跃度', description: '0 表示只在被 @ 时回复，1 表示经常插话' },
  })),
  debounce: z.enum(['fast', 'natural', 'steady']).default('natural').meta(field('Waiting', 'How long it waits for someone to finish before reading', {
    'zh-CN': { title: '等待节奏', description: '等对方说完再看的时长', options: { fast: '快', natural: '自然', steady: '稳' } },
  }, { options: { fast: 'Fast', natural: 'Natural', steady: 'Steady' } })),
  ignoreUsers: z.array(z.string()).default([]).meta(field('Ignore users', 'User ids it never reacts to, such as other bots', {
    'zh-CN': { title: '忽略用户', description: '永远不会引起回复的 QQ 号，例如其他机器人' },
  })),
  dailyReplies: z.number().int().min(0).default(200).meta(field('Replies per chat per day', '0 means no limit', {
    'zh-CN': { title: '每个会话每日回复上限', description: '0 表示不限制' },
  })),
  plannerProvider: providerField('Planner provider', '规划用的提供商'),
  plannerModel: modelField('Planner model', '规划用的模型'),
  replyProvider: providerField('Reply provider', '回复用的提供商'),
  replyModel: modelField('Reply model', '回复用的模型'),
  typingSpeed: z.number().min(1).max(50).default(8).meta(field('Typing speed', 'Characters per second when it "types" a reply', {
    'zh-CN': { title: '打字速度', description: '模拟打字时每秒的字数' },
  })),
  memory: z.boolean().default(false).meta(field('Memory', 'Remember what people talk about and an impression of each of them. Only things said in the chat are kept; anyone can clear theirs with /忘掉我', {
    'zh-CN': { title: '记忆', description: '记住聊过的事和对每个人的印象。只记聊天里自己说过的事；任何人都能用 /忘掉我 清除自己的' },
  })),
  memoryGroups: z.array(z.string()).default([]).meta(field('Remember in these groups', 'Empty means every group the companion chats in', {
    'zh-CN': { title: '只在这些群记忆', description: '留空表示拟人群聊生效的所有群' },
  })),
  memoryPrivate: z.boolean().default(true).meta(field('Remember private chats', undefined, {
    'zh-CN': { title: '私聊也记忆' },
  })),
  utilityProvider: providerField('Provider for summaries', '摘要与记忆用的提供商'),
  utilityModel: modelField('Model for summaries', '摘要与记忆用的模型'),
  embedProvider: z.string().optional().meta(field('Embedding provider', 'Recalls memories by meaning; empty recalls them by words', {
    'zh-CN': { title: '嵌入提供商', description: '按意思召回记忆；留空按字词召回' },
  }, { choices: 'providers.embedChoices' })),
  embedModel: z.string().optional().meta(field('Embedding model', 'e.g. text-embedding-3-small or bge-m3', {
    'zh-CN': { title: '嵌入模型', description: '例如 text-embedding-3-small 或 bge-m3' },
  })),
  quietHours: z.string().regex(/^(?:([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d)?$/).optional().meta(field('Sleep', 'HH:MM-HH:MM, e.g. 01:00-08:00: asleep then, it only answers when someone calls it, and sleepily. Empty never sleeps', {
    'zh-CN': { title: '作息（睡觉时间）', description: '格式 HH:MM-HH:MM，例如 01:00-08:00：这段时间在睡觉，只有被叫才会迷迷糊糊地回。留空表示不睡' },
  })),
  maxParts: z.number().int().min(1).max(6).default(3).meta(field('Most messages per reply', 'A reply is split into at most this many messages', {
    'zh-CN': { title: '每次最多几条', description: '一次回复最多拆成几条消息' },
  })),
})

export type Config = z.infer<typeof Config>
