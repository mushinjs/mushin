#!/usr/bin/env node
// Mushin.js runs its TypeScript sources directly through tsx.
import { register } from 'tsx/esm/api'

register()
await import('../src/cli.ts')
