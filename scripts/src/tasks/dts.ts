import { join, resolve } from 'path'
import { loadTsConfig } from 'load-tsconfig'
import type { Loaded } from 'load-tsconfig'
import { rollup } from 'rollup'
import dtsPlugin from 'rollup-plugin-dts'
import type { Repo } from '../'

export const dts = async (repo: Repo) => {
  // 1. 获取根目录和工作区
  // 2. 读取各工作区的tsconfig.json,
  // 3. Loaded的data为tsconfig.json文件
  // 4. 使用rollup和rollup-plugin-dts打包声明文件，且只打包声明文件
  const { rootDir, workspaces } = repo
  Object.keys(workspaces).map(async (path) => {
    const workspaceDir = resolve(rootDir, path)
    const tsconfig = loadTsConfig(join(workspaceDir, 'tsconfig.json'))
    if (!tsconfig)
      return
    const { data } = tsconfig as Loaded
    if (!data)
      return
    const { compilerOptions } = data
    const { outFile } = compilerOptions
    // TODO: if `outDir` is exists
    const input = join(workspaceDir, 'dist', 'index.d.ts')
    const output = join(workspaceDir, 'dist', outFile)

    await rollup({ input, plugins: [dtsPlugin()] })
      .then(bundle =>
        bundle.write({ file: output, format: 'esm' }))
  })
}
