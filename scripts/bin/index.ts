#!/usr/bin/env node
import cac from 'cac'
import { version } from '../package.json'

async function main() {
  const cli = cac('mushin-scripts')
  cli.parse(process.argv, { run: false })

  // registerBuildCommand(cli)

  cli.help()

  cli.version(version)

  cli.runMatchedCommand()

  if (!cli.matchedCommand)
    cli.outputHelp()
}

main()
