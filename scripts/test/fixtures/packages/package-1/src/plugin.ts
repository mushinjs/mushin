import { Context } from './context'

export interface Plugin<C extends Context = any> {
  name: string
  version?: string
  description?: string
  install?: (ctx: C) => void
}

export class Plugin {
  constructor(name: string) {
    this.name = name
  }
}

declare module './context' {
  export interface Context {
    plugins: Plugin[]
    plugin: (ctx: Context, plugin: Plugin) => void
  }
}

Context.prototype.plugin = function (ctx: Context, plugin: Plugin) {
  if (!ctx.plugins.length)
    ctx.plugins = []
  ctx.plugins.push(plugin)
}
