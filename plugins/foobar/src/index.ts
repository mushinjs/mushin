import type { AppContext } from 'mushin'
import { definePlugin } from 'mushin'
import type { Bar } from './bar'

const plugin = definePlugin({
  alias: 'foobar',
  page: '.vue',
  apply(ctx: AppContext) {

    ctx.
  },
})
export class Foo {
  constructor() {
  }
}

export type Baz = Foo & Bar
