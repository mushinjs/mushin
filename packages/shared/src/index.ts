import type { Foo } from './types'
export * from './types'

console.log('shared')

export const obj: Foo = {}

console.log(obj)

export function add(a: number, b: number): number {
  return a + b
}

export function sub(a: number, b: number): number {
  return a - b
}

export const isString = (val: unknown): val is string => typeof val === 'string'
export const isFunction = (val: unknown): val is Function => typeof val === 'function'
