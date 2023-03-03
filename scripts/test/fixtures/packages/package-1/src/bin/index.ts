import type { Bar, Foo } from '../'

export const foo: Foo<number> = 1
export const bar: Bar = '1'

console.log('FOO:', foo, 'BAR:', bar)
