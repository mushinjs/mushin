import { Context } from './context'
import type { Plugin } from './plugin'
export * from './plugin'
export * from './types'
// export * from 'package-2'

export const hello = () => console.log('Hello, package-1!')

export function definePlugin<C extends Context = any>(plugin: Plugin<C>) {
  // plugin.install()
  console.log('definePlugin', plugin)
}

export {
  Context,
}
