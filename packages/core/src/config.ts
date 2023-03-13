import type { Plugins } from './plugin'

export interface Config {
  port: number
  plugins?: Plugins
}

export function defineConfig(config: Config) {
  return config
}
