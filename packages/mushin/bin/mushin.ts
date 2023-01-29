#!/usr/bin/env node
import { execa } from 'execa'
console.log('mushin cli')

async function start() {
  console.log('start')
  process.env.HOST = 'localhost'
  process.env.PORT = '3517'
  await execa('node', ['node_modules/@mushinjs/console/.output/server/index.mjs']).stdout!.pipe(process.stdout)
}

start()
