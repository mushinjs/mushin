import { Person } from 'package-1'

// 引入其他包的类型声明
export * from 'package-1'

const hello = () => console.log('Hello, package-2!')

export const world = () => console.log('world')

declare module 'package-1' {
  export namespace Person{
    export function sayHi(): void
  }
}

// const p = new Person()

export const p = new Person()

export function createPerson() {
  return new Person()
}
