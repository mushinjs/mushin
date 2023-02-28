import { createPerson } from './index'

const p = createPerson()

p.name = '325'
Object.getPrototypeOf(p).sayHi()
