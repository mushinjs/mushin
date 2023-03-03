export interface Context {
  name: string
  config: Record<string, any>
}

export class Context {
  constructor(name: string, config: Record<string, any>) {
    this.name = name
    this.config = config
  }
}
