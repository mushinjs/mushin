import { defineConfig } from 'tsup'
import { defaultConfig } from '../../tsup.config'

const entry = {
  'index': 'src/index.ts',
  'cli/index': 'cli/index.ts',
}

export default defineConfig({
  entry,
  outDir: 'dist',
  format: ['cjs', 'esm'],
  target: 'esnext',
  ...defaultConfig,
})
