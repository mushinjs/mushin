import type { Foo } from 'package-2'
import { Person, hello, world } from 'package-2'

hello() as unknown as Foo<string>
world()

declare module 'package-2' {
  namespace Person{
    export function sayBye(): void
  }
}

const p = new Person()
p.name = '123'
Person.sayHi()
Person.sayBye()
