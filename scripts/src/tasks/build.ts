import { resolve } from 'path'
import type { CAC } from 'cac'
import { build } from 'esbuild'
import { slash } from '../../src/utils'
import { type Repo, createRepo } from '../../src'

type EntryPoints = string[] | Record<string, string> | { in: string; out: string }[]

export const getEntryPoints = (workspaceDir: string, packageJson: any): EntryPoints => {
  // TODO: support more entry points
  const entry = [resolve(workspaceDir, 'src/index.ts')]
  const { bin } = packageJson
  if (bin)
    entry.push(resolve(workspaceDir, 'bin/index.ts'))
  return entry
}

export const bundle = async (repo: Repo) => {
  const { rootDir, workspaces } = repo
  return Promise.allSettled(
    workspaces.map(async ([path, packageJson]) => {
      // 获取当前workspace的绝对路径
      const workspaceDir = resolve(rootDir, path)
      // 获取入口文件
      const entryPoints = getEntryPoints(workspaceDir, packageJson)

      console.log('entryPoints', packageJson.name, entryPoints)

      return build({
        entryPoints,
        outdir: resolve(workspaceDir, 'dist'),
        format: 'esm',
        bundle: true,
        splitting: true,
        minify: true,
        sourcemap: true,
        target: 'node16',
      })
    }))
}
