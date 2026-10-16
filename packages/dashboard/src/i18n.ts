import { createI18n } from 'vue-i18n'
import en from './locales/en'
import zhCN from './locales/zh-CN'

const KEY = 'mushin.locale'

function initialLocale() {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'en' || saved === 'zh-CN') return saved
  } catch {}
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: 'en',
  messages: { en, 'zh-CN': zhCN },
})

document.documentElement.lang = i18n.global.locale.value

export function setLocale(locale: 'en' | 'zh-CN') {
  i18n.global.locale.value = locale
  document.documentElement.lang = locale
  try {
    localStorage.setItem(KEY, locale)
  } catch {}
}
