import { type Context, field, z } from '@mushin/core'
import type {} from '@mushin/plugin-bots'

// A bot plugin is a module exporting `name`, `inject`, an optional zod `Config`, and `apply`.
export const name = 'echo'

// `bot` is this bot's own service; the plugin loads once per bot that enables it.
export const inject = ['bot']

export const Config = z.object({
  prefix: z.string().min(1).default('echo ').meta(field('Prefix', 'Messages starting with this prefix are echoed back', {
    'zh-CN': { title: '前缀', description: '以此前缀开头的消息会被复读' },
  })),
})

export function apply(ctx: Context, config: z.infer<typeof Config>) {
  ctx.bot.middleware(async (session, next) => {
    if (!session.text.startsWith(config.prefix)) return next()
    const text = session.text.slice(config.prefix.length).trim()
    if (text) await session.send(text)
  })
}
