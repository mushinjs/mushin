import { defineConfig } from 'tsup'
import defaultConfig, { dts } from '../../tsup.default'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'bin/mushin': 'bin/mushin.ts',
  },
  ...defaultConfig,
  dts: !dts ? false : {
    entry: {
      index: 'src/index.ts',
      'bin/mushin': 'bin/mushin.ts',
    },
  },
})
