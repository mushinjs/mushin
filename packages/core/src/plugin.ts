declare module './'{
  export interface Application {
    plugins: Plugin[]
  }
}

export interface Plugin {
  name: string
}

export class Plugin {
  constructor(name: string) {
    this.name = name
  }
}
