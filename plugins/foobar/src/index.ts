import type { Bar } from './bar'

export class Foo {
  constructor() {
  }
}

export type Baz = Foo & Bar
