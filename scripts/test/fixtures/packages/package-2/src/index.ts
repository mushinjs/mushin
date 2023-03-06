import type { Context } from 'package-1'

declare module 'package-1' {
  export interface Context {
    bots: Bot[]
  }
}

export interface Bot {
  name: string
}
