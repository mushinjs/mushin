import { join } from 'path'
import { build } from 'esbuild'
import { type Repo } from '../../src'

type EntryPoints = string[] | Record<string, string> | { in: string; out: string }[]

export const getEntry = (workspaceDir: string, packageJson: any): EntryPoints => {
  // TODO: support more entry points
  const entry = [join(workspaceDir, 'src/index.ts')]
  const { bin } = packageJson
  if (bin)
    entry.push(join(workspaceDir, 'bin/index.ts'))
  return entry
}

export const bundle = async (repo: Repo) => {
  const { rootDir, workspaces } = repo
  return Promise.allSettled(
    Object.keys(workspaces).map(async (path) => {
      const packageJson = workspaces[path]
      const workspaceDir = join(rootDir, path)
      const entryPoints = getEntry(workspaceDir, packageJson)

      console.log('entryPoints', packageJson.name, entryPoints)

      return build({
        entryPoints,
        outdir: join(workspaceDir, 'dist'),
        format: 'esm',
        bundle: true,
        splitting: true,
        minify: true,
        sourcemap: true,
        target: 'node16',
      })
    }))
}
