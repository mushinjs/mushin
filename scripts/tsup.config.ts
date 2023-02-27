import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  outDir: 'dist',
  platform: 'node',
  format: ['esm'],
  clean: true,
  bundle: true,
  splitting: false,
  banner: {
    js: 'import { createRequire } from \'module\';const require = createRequire(import.meta.url);',
  },
  dts: {
    resolve: true,
    // build types for `src/index.ts` only
    // otherwise `Options` will not be exported by `tsup`, not sure how this happens, probably a bug in rollup-plugin-dts
    // https://github.com/Swatinem/rollup-plugin-dts/issues/127
    entry: 'src/index.ts',
  },
})
