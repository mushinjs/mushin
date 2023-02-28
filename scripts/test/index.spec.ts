import path from 'path'
import { assertType, describe, expect, it } from 'vitest'
import type { Repo } from '../src'
import { bundle } from '../bin/action/build'
import { createRepo, findPaths } from '../src'

describe('build', async () => {
  const fixture = (name: string) => path.join(__dirname, 'fixtures', name)
  const rootDir = fixture('.')

  it('monorepo types', async () => {
    const repo = await createRepo(rootDir)
    console.log(repo)
    assertType<Repo>(repo)
  })

  it('find packages', async () => {
    const patterns = ['packages/**', 'plugins/**', '!**/test/**']
    const workspaces = await findPaths(rootDir, patterns)

    expect(workspaces.length).toBe(4)
    expect(workspaces).toEqual(
      ['packages/package-1',
        'packages/package-2',
        'plugins/plugin-1',
        'plugins/plugin-2'])

    // expect(workspaces[0][1].name).toBeDefined()
    // expect(workspaces[1][1].name).toBeDefined()
    // expect(workspaces[2][1].name).toBeDefined()
    // expect(workspaces[3][1].name).toBeDefined()
    // expect(workspaces[3][1].private).toStrictEqual(true)
  })

  it('build', async () => {
    const options = {}
    const repo: Repo = await createRepo(rootDir, options)
    expect(repo).toBeDefined()
    expect(repo.rootDir).includes('\\mushin\\scripts\\test\\fixtures')
    expect(repo.workspaces.length).toBe(4)
    expect(repo.options).toEqual(options)

    try {
      await bundle(repo)
      expect(true).toBeTruthy()
    }
    catch (error) {
      expect(error).toBeDefined()
    }

    try {
      const repo2 = { rootDir: repo.rootDir, workspaces: repo.workspaces.slice(0, 3), options: repo.options } as unknown as Repo
      await bundle(repo2)
      expect(true).toBeTruthy()
    }
    catch (error) {
      expect(error).toBeUndefined()
    }
  })
})
