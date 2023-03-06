export interface Context {
  ctx: any
  config: any
}

export class Context {
  constructor(config?: any) {
    this.config = config

    this.ctx = this
  }
}
