#!/usr/bin/env node
import cac from 'cac'
import { version } from '../../package.json'

export const cli = cac('mushin').help().version(version)

cli.command('start', 'Start the development server').action(() => {
  console.log('start')
})

cli.parse()

if (!cli.matchedCommand)
  cli.outputHelp()
