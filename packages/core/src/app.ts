const version = require('./package.json').version
export interface App {
  version: string
  config: any

  _context: AppContext

  start: () => void
}

export interface AppContext {
  app: App
  config: any
  plugins: any

  reload?: () => void
}

export function createApp(): App {
  const context = createAppContext()

  let isStarted = false

  const app = (context.app = {
    _context: context,

    version,

    get config() {
      return context.config
    },
    start() {
      if (isStarted)
        return
      // TODO:
      // loader()
      isStarted = true
    },
    // ctx.app.config
  })

  return app
}

export function createAppContext(): AppContext {
  return {
    app: null as any,
    config: {},
    plugins: {},

    reload() {
      this.app && this.app.start()
    },
  }
}
