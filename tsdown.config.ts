import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type UserConfig } from 'tsdown'

// Published packages ship JavaScript in dist/. Inside this repository they still point at src/
// (tsx runs it), and `publishConfig.exports` switches them to dist/ when pnpm packs them.
//
// Every file under src/ becomes one file under dist/ (unbundle), so paths built from
// import.meta.url, such as `../package.json`, mean the same thing in both.

/** Packages that are not plain Node packages: the dashboard is a Vite app, and ui ships Vue sources. */
const special = new Set(['dashboard', 'ui'])

/** Extra entries a package needs besides src/index.ts. */
const extraEntries: Record<string, string[]> = {
  cli: ['src/cli.ts'],
}

const base = {
  format: 'esm',
  platform: 'node',
  target: 'node22.13',
  unbundle: true,
  dts: true,
  fixedExtension: false,
  sourcemap: true,
  clean: true,
  // Every bare import stays an import: dependencies are installed next to the package, and
  // optional ones (such as the PDF and Word readers of plugin-knowledge) are imported only when present.
  // The pattern is also tested against resolved paths, so it must not match `C:\...` on Windows:
  // only package names (optionally scoped, with a subpath) and `node:` builtins.
  deps: { neverBundle: [/^node:/, /^(@[\w-][\w.-]*\/)?[\w-][\w.-]*(\/.*)?$/] },
  logLevel: 'warn',
  // Declarations take most of each build; the timing report says nothing new.
  checks: { pluginTimings: false },
} satisfies UserConfig

const packages = readdirSync('packages').filter((name) => !special.has(name) && existsSync(join('packages', name, 'src/index.ts')))

export default defineConfig([
  ...packages.map((name): UserConfig => ({
    ...base,
    name: `@mushin/${name}`,
    cwd: join('packages', name),
    entry: ['src/index.ts', ...(extraEntries[name] ?? [])],
    outDir: 'dist',
  })),
  {
    // A uno.config file imports the preset from Node, so it is the one part of ui that ships compiled.
    ...base,
    name: '@mushin/ui',
    cwd: 'packages/ui',
    entry: ['src/preset.ts'],
    outDir: 'dist',
    platform: 'neutral',
  },
])
