import type { Context } from '@mushin/core'
import type {} from '@mushin/plugin-bots'
import type {} from '@mushin/plugin-providers'
import { Config } from './config'

export * from './config'
export * from './scope'
export * from './interest'
export * from './transcript'

export const name = 'companion'
export const inject = ['bot', 'llm']

export const PACKAGE = '@mushin/bot-plugin-companion'

export { Config }

export function apply(ctx: Context, config: Config) {
  ctx.logger('companion').debug('companion chat on bot %s', ctx.bot.id)
}
