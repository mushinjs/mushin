import { defineConfig, presetIcons, presetWind3, transformerDirectives } from 'unocss'
import { presetMushin } from './packages/ui/src/preset'

/**
 * UnoCSS for the dashboard and @mushin/ui. It sits at the repository root so editor extensions
 * find it; packages point their build at this file.
 *
 * Utilities follow Tailwind's names (presetWind3); the one UnoCSS-only feature in use is icons by
 * class name (`i-lucide-trash-2`) from @iconify/json, of which only the icons used end up in the CSS.
 * Write class names out in full: a class assembled at runtime (`i-lucide-${name}`) is never found.
 */
export default defineConfig({
  presets: [
    presetWind3({ dark: { dark: 'html[data-theme="dark"]', light: 'html[data-theme="light"]' } }),
    presetIcons({
      extraProperties: { 'display': 'inline-block', 'flex': 'none', 'vertical-align': '-0.125em' },
    }),
    presetMushin(),
  ],
  transformers: [transformerDirectives()],
  content: {
    // Icon and colour classes also live in .ts files (icon tables, column renderers).
    pipeline: { include: [/\.(vue|ts)($|\?)/], exclude: [/node_modules/, /\/locales\//] },
  },
})
