import path, { resolve } from 'path'
import { assertType, describe, expect, it } from 'vitest'
import type { Repo } from '../src'
import { bundle } from '../src/tasks/build'
import { dts } from '../src/tasks/dts'
import { createRepo } from '../src'

const fixture = (name?: string) => path.join(__dirname, 'fixtures', name ?? '.')
const rootDir = fixture()

describe('build', async () => {
  it('create repo', async () => {
    await expect(createRepo).rejects.toThrow()
  })

  it('build', async () => {
    const options = {}
    const repo = await createRepo(rootDir, options)

    await expect(bundle(repo))
  })
})

describe('dts', async () => {
  it('dts', async () => {
    const repo = await createRepo(rootDir)
    await dts(repo)
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
    // const distDirs = workspaces.map(item => resolve(rootDir, item[0], 'dist'))
    const distDirs = Object.keys(workspaces).map(item => resolve(rootDir, item, 'dist'))
    return distDirs
    // console.log(distDirs)
    // await clean(distDirs)
  })
})
