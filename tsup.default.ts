import { Options } from 'tsup'
import { spawn } from 'child_process'
import pico from 'picocolors'

export const dts = true

const config: Options = {
  format: ['cjs', 'esm'],
  bundle: true,
  splitting: false,
  silent: true,
  clean: true,
  dts: !dts ? false : {
    entry: {
      index: 'temp/src/index.d.ts',
    },
  },
  onSuccess: async () => {
    await spawn('pnpm', ['run', 'type'])
    console.log(pico.green(`Success Build!`))
  },
}

export default config
