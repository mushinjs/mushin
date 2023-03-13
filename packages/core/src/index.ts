import { add } from '@mushinjs/shared'

export * from './app'
export * from './plugin'
export * from './config'

interface PluginOptions {
  alias?: string
  [key: string]: any
}
export interface Plugins {
  [key: string]: PluginOptions
}

console.log(add(1, 2))
