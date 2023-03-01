import { join, resolve } from 'path'
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { globby } from 'globby'
import yaml from 'js-yaml'
import { slash } from './utils'

export const requireSafe = (path: string) => {
  try {
    const require = createRequire(import.meta.url)
    return require(path)
  }
  catch (e: any) {
    if (e.code !== 'MODULE_NOT_FOUND')
      throw e
  }
}

export const findPackageJson = async (rootDir: string, paths: string[]): Promise<Workspace> => {
  return Object.fromEntries(paths.map((path) => {
    const json = requireSafe(resolve(rootDir, path, 'package.json'))
    return [path.replace('package.json', ''), json]
  }).filter(Boolean))
}

export const createRepo = async (rootDir: string, options?: any): Promise<Repo> => {
  const content = await readFileSync(join(rootDir, 'pnpm-workspace.yaml'), 'utf-8')
  const { packages } = await yaml.load(content) as { packages: string[] }

  const patterns = packages.map(slash)
  const paths = await globby(patterns,
    {
      cwd: rootDir,
      onlyDirectories: true,
      expandDirectories: false,
      deep: 1,
      ignore: ['**/node_modules/**'],
    })
  const workspaces = await findPackageJson(rootDir, paths)

  console.log(`\nFound ${Object.keys(workspaces).length} workspaces.`)
  return {
    rootDir,
    workspaces,
    options,
  }
}

export interface PackageJson {
  name: string
  version: string
  private?: boolean
  exports?: Record<string, string> | string
  module?: Record<string, string> | string
  bin?: Record<string, string> | string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  // type?: string
  // main?: string | Record<string, string>
  // types?: string | Record<string, string>
  // scripts?: Record<string, string>
  // peerDependencies?: Record<string, string>
  // optionalDependencies?: Record<string, string>
}

export interface Workspace {
  [path: string]: PackageJson
}

export interface Repo {
  rootDir: string
  workspaces: Workspace
  targets?: any[]
  options: any
}
