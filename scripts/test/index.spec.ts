import path from 'path'
import { assertType, describe, expect, it } from 'vitest'
import type { Repo } from '../src'
import { createRepo, findWorkspaces } from '../src'

describe('build', async () => {
  const fixture = (name: string) => path.join(__dirname, 'fixtures', name)
  const rootDir = fixture('.')

  it('monorepo types', async () => {
    const repo = await createRepo({ rootDir })
    assertType<Repo>(repo)
  })

  it('find packages', async () => {
    const patterns = ['packages/**', 'plugins/**', '!**/test/**']
    const workspaces = await findWorkspaces(rootDir, patterns)

    expect(workspaces.length).toBe(4)
    expect(workspaces[0][0]).toBe('packages/package-1')
    expect(workspaces[1][0]).toBe('packages/package-2')
    expect(workspaces[2][0]).toBe('plugins/plugin-1')
    expect(workspaces[3][0]).toBe('plugins/plugin-2')

    expect(workspaces[0][1].name).toBeDefined()
    expect(workspaces[1][1].name).toBeDefined()
    expect(workspaces[2][1].name).toBeDefined()
    expect(workspaces[3][1].name).toBeDefined()
    expect(workspaces[3][1].private).toStrictEqual(true)
  })

  it('build', async () => {
    // const repo = await createRepo({ rootDir })
    // // console.log('repo', repo)
    // await build(repo)
  })
})
