import { resolve } from 'path'
import { build } from 'esbuild'
import { type Repo } from '../../src'

type EntryPoints = string[] | Record<string, string> | { in: string; out: string }[]

export const getEntry = (workspaceDir: string, packageJson: any): EntryPoints => {
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
      const workspaceDir = resolve(rootDir, path)
      const entryPoints = getEntry(workspaceDir, packageJson)

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
