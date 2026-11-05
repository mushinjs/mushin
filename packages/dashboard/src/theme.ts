import { computed, ref, watch } from 'vue'

export type ThemeMode = 'auto' | 'light' | 'dark'

const KEY = 'mushin.theme'

function read(): ThemeMode {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'auto'
  } catch {
    return 'auto'
  }
}

export const themeMode = ref<ThemeMode>(read())

watch(themeMode, (mode) => {
  try {
    localStorage.setItem(KEY, mode)
  } catch {}
})

/**
 * The palette behind both themes, for what draws on a canvas (charts, graphs) and cannot read CSS
 * variables. @mushin/ui/theme.css declares the same values as --bg, --s1, --primary, …; keep the two in step.
 */
export const palettes = {
  light: {
    primary: '#4F5BD5', hover: '#6370E0', pressed: '#3F4AB8',
    bg: '#F5F6FA', s1: '#FFFFFF', s2: '#EEF0F6', line: '#E1E4EE',
    fg: '#1B1D29', fg2: '#5D6175', fg3: '#8B8FA3',
    ok: '#1F9D63', warn: '#C27A06', bad: '#D2344D',
  },
  dark: {
    primary: '#7D8BF5', hover: '#97A3F8', pressed: '#6474EC',
    bg: '#0E0F14', s1: '#16171F', s2: '#1F212B', line: '#2A2D3A',
    fg: '#E8E9F0', fg2: '#A0A3B6', fg3: '#6E7287',
    ok: '#3CCB8A', warn: '#F0B04A', bad: '#F06A7E',
  },
}

/**
 * Series colours for charts, in a fixed order (series 1 is always the first colour). Five slots,
 * checked for colour-blind separation on each theme's card surface; a sixth series and beyond are
 * folded into "other" by the chart.
 */
export const chartColors = {
  light: ['#4F5BD5', '#1F9E8E', '#D4762A', '#B84C8C', '#3D8FD0'],
  dark: ['#6874EA', '#1FA593', '#CF7029', '#C65A96', '#4E9AD8'],
}

// The system's light or dark preference, for the 'auto' mode.
const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined
const osDark = ref(query?.matches ?? false)
query?.addEventListener('change', (event) => {
  osDark.value = event.matches
})

const isDark = computed(() => themeMode.value === 'dark' || (themeMode.value === 'auto' && osDark.value))

export function useTheme() {
  return { isDark }
}
