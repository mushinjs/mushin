import { join, resolve } from 'path'
import { loadTsConfig } from 'load-tsconfig'
import type { Loaded } from 'load-tsconfig'
import type { Repo } from 'src'
// import rollup from 'rollup'

export const dts = async (repo: Repo) => {
  // 1. 获取根目录和工作区
  // 2. 读取各工作区的tsconfig.json, 其中include字段中的 ts文件为入口文件，分别打包为出口文件
  //    即当outFile存在时，输出单一文件。当outDir存在时，根据include字段的ts文件分别输出出口文件
  // 3. Loaded的data为tsconfig.json文件
  // 4. 先使用tsc命令编译，再使用rollup打包，将声明文件中的 declare module 中的内容展开
  const { rootDir, workspaces } = repo
  const outputOptions = Object.keys(workspaces).map((path) => {
    const workspaceDir = resolve(rootDir, path)
    const tsconfig = loadTsConfig(join(workspaceDir, 'tsconfig.json'))
    const { data } = tsconfig as Loaded
    const { compilerOptions } = data
    const { outFile, outDir } = compilerOptions
    if (outFile) {
      // 输出单一文件的outputOptions

    }
    else if (outDir) {
      // 输出多个文件的outputOptions
    }
  })
}
