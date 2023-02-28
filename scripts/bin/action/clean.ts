import { resolve } from 'path'
import { rm } from 'fs/promises'
import { type CAC } from 'cac'
import { createRepo } from '../../src'

export const removeFiles = (path: string, options: any) => {
  return rm(path, options)
}

export default (cli: CAC) => {
  cli.command('clean', 'Clean the dist directories', { ignoreOptionDefaultValue: true })
    .action(async (rootDir, options) => {
      const repo = await createRepo(rootDir)
      const { workspaces } = repo
      Promise.all(workspaces.map(async ([path]) => {
        const dir = resolve(rootDir, path, 'dist')
        return removeFiles(dir, { recursive: true, force: true })
      }))
    })
}
