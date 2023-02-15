export interface Application {
  app: any
  config: any
}

export class Application {
  constructor(config?: any) {
    this.config = config

    this.app = this
  }
}
