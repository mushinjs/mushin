import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import en from '../src/locales/en'
import zhCN from '../src/locales/zh-CN'

/** Every message key, as a dotted path. */
function keys(messages: Record<string, any>, prefix = ''): string[] {
  return Object.entries(messages).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return value && typeof value === 'object' ? keys(value, path) : [path]
  })
}

// vue-i18n reads `@`, `{`, `}`, `|` and `%` as syntax; a stray one fails only when that message is shown.
describe.each([['en', en], ['zh-CN', zhCN]] as const)('the %s messages', (locale, messages) => {
  it('all compile', () => {
    const i18n = createI18n({ legacy: false, locale, messages: { [locale]: messages as any }, missingWarn: false, fallbackWarn: false, warnHtmlMessage: false })
    const failed: string[] = []
    for (const key of keys(messages)) {
      if (typeof (key.split('.').reduce((value: any, part) => value?.[part], messages)) !== 'string') continue
      try {
        i18n.global.t(key, {})
      } catch (error) {
        failed.push(`${key}: ${(error as Error).message}`)
      }
    }
    expect(failed).toEqual([])
    expect(i18n.global.t('bots.guide.telegram.polling')).toContain('@BotFather')
  })
})
