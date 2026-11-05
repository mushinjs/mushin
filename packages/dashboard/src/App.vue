<script setup lang="ts">
import { dateEnUS, dateZhCN, enUS, NConfigProvider, NDialogProvider, NGlobalStyle, NMessageProvider, zhCN } from 'naive-ui'
import { computed, watchEffect } from 'vue'
import { UiProvider } from '@mushin/ui'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import AppLayout from './components/AppLayout.vue'
import HighlightLayer from './components/HighlightLayer.vue'
import { useTheme } from './theme'

const route = useRoute()
const { locale, t } = useI18n()
const { theme, overrides, isDark } = useTheme()
// Lets global CSS (e.g. the logo) adapt to the active theme.
watchEffect(() => document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light'))
const isChinese = computed(() => locale.value.startsWith('zh'))
// Naive UI's English placeholders ("Please Input", "Please Select") read as machine text. A field's label
// already says what goes in it, so an empty field stays empty unless the page gives its own placeholder.
const english = {
  ...enUS,
  Input: { ...enUS.Input, placeholder: '' },
  InputNumber: { ...enUS.InputNumber, placeholder: '' },
  Select: { ...enUS.Select, placeholder: 'Select' },
  Cascader: { ...enUS.Cascader, placeholder: 'Select' },
}
// The shared components' own words, in the dashboard's language.
const uiText = computed(() => {
  const keys = ['on', 'off', 'enabled', 'disabled', 'clear', 'close', 'noOptions', 'add', 'remove', 'ok', 'cancel', 'loading', 'previous', 'next', 'preview'] as const
  return { ...Object.fromEntries(keys.map((key) => [key, t(`ui.${key}`)])), useValue: t('ui.useValue', { value: '{value}' }), perPage: t('ui.perPage', { n: '{n}' }) }
})
</script>

<template>
  <NConfigProvider
    :theme="theme"
    :theme-overrides="overrides"
    :locale="isChinese ? zhCN : english"
    :date-locale="isChinese ? dateZhCN : dateEnUS"
  >
    <NGlobalStyle />
    <NMessageProvider>
      <NDialogProvider>
        <UiProvider :text="uiText">
          <RouterView v-if="route.meta.public" />
          <AppLayout v-else />
          <HighlightLayer />
        </UiProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
