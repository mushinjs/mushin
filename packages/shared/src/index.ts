import { Foo } from './types'
export * from './types'

console.log('shared')

const obj: Foo = {}

console.log(obj)
