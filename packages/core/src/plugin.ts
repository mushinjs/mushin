import type { AppContext } from './app'

export enum PluginType {
  Bot = 'bot',
  Theme = 'theme',
  Adaptor = 'adaptor',
  Default = 'default',
}

export interface Plugin {
  name: string
  alias?: string
  type?: string
  parent: Plugin | null
  appContext: AppContext

  update: () => void
}

export interface Plugins {
  [key: string]: Plugin
}

export function createPlugin(setup: () => void): Plugin {
  return {

  }
}
