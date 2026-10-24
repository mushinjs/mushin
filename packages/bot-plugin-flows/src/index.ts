import type { Context } from '@mushin/core'
import type {} from '@mushin/plugin-bots'
import type {} from '@mushin/plugin-flows'

export const name = 'flows'
export const inject = ['bot', 'flows']

/** Flows run before plugins with the default priority, such as LLM chat. */
export const PRIORITY = 10

export function apply(ctx: Context) {
  ctx.bot.middleware(async (session, next) => {
    const { consumed } = await ctx.flows.dispatch(ctx, session)
    // A matched trigger keeps the message unless it lets other plugins answer too.
    if (!consumed) return next()
  }, { priority: PRIORITY })
}
