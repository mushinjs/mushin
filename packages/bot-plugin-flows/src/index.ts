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

  // Command nodes of the flows on this bot show in its /help and command list.
  ctx.bot.defineCommands(() => ctx.flows.commandsOn(ctx.bot.id))

  // Event triggers (a member joins, a poke…) and schedule triggers run through this bot.
  ctx.flows.useRunner(ctx)
  ctx.bot.onEvent((event) => {
    ctx.flows.dispatchEvent(ctx, event).catch((error) => ctx.logger('flows').warn('event %s: %s', event.name ?? event.type, error))
  })
}
