import { defineConfig, presetAttributify, presetIcons, presetUno } from 'unocss'

export default defineConfig({
  shortcuts: {
    'border-base': 'border-gray:60 dark:border-gray:40',
    'bg-base': 'bg-white dark:bg-#15151580',
    'bg-active': 'bg-#9ca3af20',
  },
  presets: [
    presetAttributify(),
    presetIcons(),
    presetUno(),
  ],
  mergeSelectors: false,
})
