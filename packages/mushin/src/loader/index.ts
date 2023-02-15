import { resolve } from 'path'
// @ts-expect-error TODO: i can't figure out how to make this work
import { Application } from '@mushinjs/core'

export interface Loader {
  app: Application
  baseDir: string
  config: any
  filename: string

  loadConfig(): Promise<void>
  createApp(): Promise<Application>
}

export class Loader {
  public baseDir = process.cwd()

  constructor(filename?: string) {
    if (filename) {
      filename = resolve(this.baseDir, filename)
      this.baseDir = resolve(filename, '..')
    }
    else {
      this.loadConfig()
    }
  }

  async loadConfig() {
    const config = await import(resolve(this.baseDir, 'mushin.config.yml'))
  }

  async createApp() {
    const app = new Application()
    return app
  }
}
