import { darkTheme, type GlobalThemeOverrides, useOsTheme } from 'naive-ui'
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

// Field descriptions wrap onto several lines; keep them clear of the next field's label.
const form: GlobalThemeOverrides['Form'] = {
  feedbackPadding: '4px 0 14px 2px',
  feedbackFontSizeMedium: '13px',
}

const lightOverrides: GlobalThemeOverrides = {
  Form: form,
  common: {
    primaryColor: '#3B4A8C',
    primaryColorHover: '#4D5DA6',
    primaryColorPressed: '#2E3A70',
    primaryColorSuppl: '#4D5DA6',
    borderRadius: '6px',
  },
}

const darkOverrides: GlobalThemeOverrides = {
  Form: form,
  common: {
    primaryColor: '#8D9BE6',
    primaryColorHover: '#A3AFEE',
    primaryColorPressed: '#7383D6',
    primaryColorSuppl: '#A3AFEE',
    borderRadius: '6px',
  },
}

export function useTheme() {
  const os = useOsTheme()
  const isDark = computed(() => themeMode.value === 'dark' || (themeMode.value === 'auto' && os.value === 'dark'))
  return {
    isDark,
    theme: computed(() => (isDark.value ? darkTheme : null)),
    overrides: computed(() => (isDark.value ? darkOverrides : lightOverrides)),
  }
}
