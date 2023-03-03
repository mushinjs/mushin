#!/usr/bin/env node
import { resolve } from 'path'
import cac from 'cac'
import { createRepo } from 'src'
import { removeFiles, slash } from 'src/utils'
import { bundle } from 'src/tasks/build'
import { dts } from 'src/tasks/dts'

import { version } from '../../package.json'

async function main() {
  const cli = cac('mushin-scripts')
  // cli.parse(process.argv, { run: false })

  cli.command('build <rootDir>', 'Build the workspaces in the monorepo')
    .option('--clean', 'Clean output directories before build', { default: false })
    // .option('--debug', 'Enable debug mode', { default: false })
    // .option('--silent', 'Disable all logs', { default: false })
    // .option('--watch', 'Watch files and rebuild on change', { default: false })
    // .option('--pipeline', 'Pipeline name', { default: '_' })
    // .option('--workspace <workspace>', 'Workspace name', { default: '' })
    .action(async (rootDir = '.', options) => {
      rootDir = slash(resolve(process.cwd(), rootDir))
      const repo = await createRepo(rootDir, options)
      await bundle(repo)
    })

  cli.command('dts', 'Clean the dist directories')
    // .option('--watch', 'Watch files and rebuild on change', { default: false })
    .action(async (rootDir, _) => {
      rootDir = slash(resolve(process.cwd(), rootDir))
      const repo = await createRepo(rootDir)
      await dts(repo)
    })

  cli.command('clean', 'Clean the dist directories')
    .action(async (rootDir, _) => {
      const repo = await createRepo(rootDir)
      const { workspaces } = repo
      Promise.all(Object.keys(workspaces).map(async (path) => {
        const dir = resolve(rootDir, path, 'dist')
        return removeFiles(dir, { recursive: true, force: true })
      }))
    })

  cli.help()
  cli.version(version)

  // cli.runMatchedCommand()

  if (!cli.matchedCommand)
    cli.outputHelp()
}

main()
