import { defineConfig } from 'tsup'

export default defineConfig({
  name: 'shared',
  outDir: 'dist',
  format: ['cjs', 'esm'],
  target: 'node16',
  clean: true,
  sourcemap: true,
  bundle: true,
  splitting: false,
  silent: true,
  dts: {
    entry: { index: 'temp/index.d.ts' },
  },
})
