import { Context } from './context'

export interface Bot {
  name: string
}
export class Bot {
  constructor(name: string) {
    this.name = name
  }
}
declare module './context'{
  export interface Context {
    bots: Bot[]
  }
}
