#!/usr/bin/env node
import cac from 'cac'
import { version } from '../package.json'
import registerStartCommand from './start'

export const cli = cac('mushin').help().version(version)

registerStartCommand(cli)

cli.parse()

if (!cli.matchedCommand)
  cli.outputHelp()
