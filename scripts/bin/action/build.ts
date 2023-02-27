import { resolve } from 'path'
import type { CAC } from 'cac'
import { build } from 'esbuild'
import { slash } from '../../src/utils'
import { type Repo, createRepo } from '../../src'

type EntryPoints = string[] | Record<string, string> | { in: string; out: string }[]

export const getEntryPoints = (packageJson: any): EntryPoints => {
  // TODO: support more entry points
  const entry = ['src/index.ts']
  const { bin } = packageJson
  if (bin)
    entry.push('bin/index.ts')
  return entry
}

export const bundle = async (repo: Repo) => {
  const { workspaces } = repo
  await Promise.all(
    workspaces.map(async ([path, packageJson]) => {
      const { private: _private } = packageJson
      if (_private)
        return

      // 获取入口文件
      const entryPoints = getEntryPoints(packageJson)

      console.log('entryPoints', packageJson.name, entryPoints)

      return build({
        entryPoints,
        outdir: resolve(repo.rootDir, path, 'dist'),
        format: 'esm',
        bundle: true,
        splitting: true,
        minify: true,
        sourcemap: true,
        target: 'node16',
      })
    }))
}

export default (cli: CAC) => {
  cli.command('build <rootDir>', 'Build the workspaces in the monorepo', { ignoreOptionDefaultValue: true })
    // .option('--debug', 'Enable debug mode', { default: false })
    // .option('--silent', 'Disable all logs', { default: false })
    // .option('--clean', 'Clean output directory before build', { default: false })
    // .option('--watch', 'Watch files and rebuild on change', { default: false })
    // .option('--pipeline', 'Pipeline name', { default: '_' })
    .option('--workspace <workspace>', 'Workspace name', { default: 'repo' })
    .action(async (rootDir, options) => {
      console.log(rootDir, options)

      rootDir = slash(resolve(process.cwd(), rootDir[0] || options.rootDir || '.'))
      const repo = await createRepo(rootDir, options)
      await bundle(repo)

      // .then((entryPoints) => {
      //   entryPoints.map((p) => {
      //     console.log(`build ${path}/${p} -> ${path}/dist/${p.replace(/\.ts$/, '.js')}`)
      //     return true
      //   })
      // })
      // .catch((e) => {
      //   console.error('error', JSON.stringify(e))
      // })
    })
}
