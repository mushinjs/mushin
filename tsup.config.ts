import { defineConfig } from 'tsup'

console.log(process.cwd())
export const defaultConfig = {
  clean: true,
  sourcemap: true,
  bundle: true,
  splitting: false,
  silent: true,
}

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['cjs', 'esm'],
  target: 'esnext',
  ...defaultConfig,
})
