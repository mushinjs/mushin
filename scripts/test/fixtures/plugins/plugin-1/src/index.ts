import type { Foo } from 'package-2'
import { hello, world } from 'package-2'

hello() as unknown as Foo<string>
world()
