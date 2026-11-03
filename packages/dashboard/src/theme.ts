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

/**
 * The palette behind both themes. style.css declares the same values as CSS variables
 * (--bg, --s1, --primary, …) for the dashboard's own markup; keep the two in step.
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

function overridesFor(c: typeof palettes.light): GlobalThemeOverrides {
  return {
    Form: form,
    common: {
      primaryColor: c.primary,
      primaryColorHover: c.hover,
      primaryColorPressed: c.pressed,
      primaryColorSuppl: c.hover,
      successColor: c.ok,
      successColorHover: c.ok,
      successColorSuppl: c.ok,
      warningColor: c.warn,
      warningColorHover: c.warn,
      warningColorSuppl: c.warn,
      errorColor: c.bad,
      errorColorHover: c.bad,
      errorColorSuppl: c.bad,
      bodyColor: c.bg,
      cardColor: c.s1,
      modalColor: c.s1,
      popoverColor: c.s1,
      tableColor: c.s1,
      inputColor: c.s2,
      inputColorDisabled: c.s2,
      borderColor: c.line,
      dividerColor: c.line,
      textColor1: c.fg,
      textColor2: c.fg,
      textColor3: c.fg2,
      placeholderColor: c.fg3,
      borderRadius: '8px',
      fontFamily: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
      fontFamilyMono: "ui-monospace, 'Cascadia Code', Consolas, monospace",
    },
    Layout: { color: c.bg, siderColor: c.s1, headerColor: c.s1, siderBorderColor: c.line, headerBorderColor: c.line },
    Card: { borderColor: c.line, borderRadius: '10px' },
    // White text on the primary colour in both themes; the dark theme's default is near-black.
    Button: {
      textColorPrimary: '#FFFFFF',
      textColorHoverPrimary: '#FFFFFF',
      textColorPressedPrimary: '#FFFFFF',
      textColorFocusPrimary: '#FFFFFF',
      fontWeight: '500',
    },
    // Inputs are filled surfaces; the border shows on hover and focus only.
    Input: { border: '1px solid transparent', borderHover: `1px solid ${c.line}` },
  }
}

const lightOverrides = overridesFor(palettes.light)
const darkOverrides = overridesFor(palettes.dark)

export function useTheme() {
  const os = useOsTheme()
  const isDark = computed(() => themeMode.value === 'dark' || (themeMode.value === 'auto' && os.value === 'dark'))
  return {
    isDark,
    theme: computed(() => (isDark.value ? darkTheme : null)),
    overrides: computed(() => (isDark.value ? darkOverrides : lightOverrides)),
  }
}
