#!/usr/bin/env node
// A published install runs the compiled dist/. Inside the repository the TypeScript sources run through tsx.
import { existsSync } from 'node:fs'

const source = new URL('../src/cli.ts', import.meta.url)
if (existsSync(source)) {
  const { register } = await import('tsx/esm/api')
  register()
  await import(source.href)
} else {
  await import('../dist/cli.js')
}
