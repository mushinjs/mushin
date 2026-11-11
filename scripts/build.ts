// Builds every published package into its dist/ folder.
//
// Usage: tsx scripts/build.ts [package names...]
//
// Declaration files come from the TypeScript compiler, which keeps memory between builds in one process,
// so each package builds in a process of its own, a few at a time.
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'
import configs from '../tsdown.config'

const [flag, ...args] = process.argv.slice(2)

if (flag === '--one') {
  const config = configs.find((item) => item.name === args[0])
  if (!config) throw new Error(`No build config for ${args[0]}`)
  await build({ ...config, config: false })
} else {
  const only = new Set([flag, ...args].filter(Boolean))
  const queue = configs.filter((config) => !only.size || only.has(config.name!))
  const script = fileURLToPath(import.meta.url)
  let failed = false
  const worker = async () => {
    for (let config = queue.shift(); config; config = queue.shift()) {
      const started = Date.now()
      const code = await new Promise<number>((resolve) => {
        spawn(process.execPath, [...process.execArgv, script, '--one', config.name!], { stdio: 'inherit' })
          .on('exit', (code) => resolve(code ?? 1))
      })
      if (code) failed = true
      console.log(`${code ? 'FAILED' : 'built '} ${config.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(4, availableParallelism() - 1)) }, worker))
  if (failed) process.exit(1)
}
