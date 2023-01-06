import { defineConfig } from 'tsup'
import defaultConfig from '../../tsup.default'

export default defineConfig({
  entry: ['src/index.ts'],
  ...defaultConfig,
})
