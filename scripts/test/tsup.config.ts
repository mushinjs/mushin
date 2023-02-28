import { defineConfig } from 'tsup'

export default defineConfig({
  entryPoints: {
    'packages/package-1/dist/index': 'fixtures/packages/package-1/src/index.ts',
    'packages/package-2/dist/index': 'fixtures/packages/package-2/src/index.ts',
    'plugins/plugin-1/dist/index': 'fixtures/plugins/plugin-1/src/index.ts',
  },
  format: 'esm',
  outDir: 'fixtures',
  splitting: false,
})
