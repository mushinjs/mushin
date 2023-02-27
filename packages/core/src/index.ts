// @ts-expect-error - TODO: TS import error. I can't figure out how to make this work
import { type Application, add } from '@mushinjs/shared'

export * from './app'
export * from './plugin'

const foo: Application = {}

console.log(add(1, 2))
