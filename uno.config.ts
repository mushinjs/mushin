import { defineConfig, presetAttributify, presetIcons, presetUno } from 'unocss'

export default defineConfig({
  shortcuts: {
    'border-base': 'border-gray:600 dark:border-gray-300',
    'bg-base': 'bg-white dark:bg-#151515',
    'bg-active': 'bg-#9ca3af20',
  },
  presets: [
    presetAttributify(),
    presetIcons(),
    presetUno(),
  ],
  mergeSelectors: false,
})
