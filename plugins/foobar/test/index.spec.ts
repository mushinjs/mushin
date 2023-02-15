import { assertType, test } from 'vitest'
import { Application } from 'mushin'

test('mushin types', () => {
  const app = new Application()
  assertType<Application>(app)

  console.log(app)
})
