import type { Preset } from 'unocss'

/** A colour from theme.css, with its soft fill when it has one. */
const tone = (name: string) => ({ DEFAULT: `var(--${name})`, soft: `var(--${name}-soft)` })

/**
 * The Mushin.js UnoCSS preset: theme.css tokens as colours (`bg-s1`, `text-fg2`, `border-line`,
 * `bg-primary-soft`, `text-bad`…), so utilities follow the light and dark themes on their own.
 * Use it next to presetWind3 and presetIcons; the repository's uno.config.ts shows how.
 */
export function presetMushin(): Preset {
  return {
    name: '@mushin/ui',
    theme: {
      colors: {
        bg: 'var(--bg)',
        s1: 'var(--s1)',
        s2: 'var(--s2)',
        s3: 'var(--s3)',
        line: { DEFAULT: 'var(--line)', strong: 'var(--line-strong)' },
        fg: { DEFAULT: 'var(--fg)', 2: 'var(--fg2)', 3: 'var(--fg3)' },
        primary: { ...tone('primary'), hover: 'var(--primary-hover)', fg: 'var(--primary-fg)' },
        ok: tone('ok'),
        warn: tone('warn'),
        bad: tone('bad'),
        info: tone('info'),
        idle: 'var(--idle)',
      },
      borderRadius: { DEFAULT: 'var(--radius-sm)', card: 'var(--radius)' },
      boxShadow: { DEFAULT: 'var(--shadow)', pop: 'var(--shadow-pop)' },
      fontFamily: { mono: 'var(--mono)' },
    },
  }
}
