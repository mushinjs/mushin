import path, { resolve } from 'path'
import { assertType, describe, expect, it } from 'vitest'
import type { Repo } from '../src'
import { bundle } from '../src/tasks/build'
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
    const workspacesPath = await findPaths(rootDir, patterns)

    expect(workspacesPath.length).toBe(4)
    expect(workspacesPath).toEqual(
      [
        'packages/package-1',
        'packages/package-2',
        'plugins/plugin-1',
        'plugins/plugin-2',
      ])

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

describe('clean', async () => {
  const fixture = (name: string) => path.join(__dirname, 'fixtures', name)
  const rootDir = fixture('.')

  it('monorepo types', async () => {
    const repo = await createRepo(rootDir)
    console.log(repo)
    assertType<Repo>(repo)
  })

  it('clean', async () => {
    const repo: Repo = await createRepo(rootDir)
    const { workspaces } = repo
    // 获取当前workspace的绝对路径
    const distDirs = workspaces.map(item => resolve(rootDir, item[0], 'dist'))
    // console.log(distDirs)
    // await clean(distDirs)
  })
})
