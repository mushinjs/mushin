<script setup lang="ts">
import { UiProvider } from '@mushinjs/ui'
import { computed, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import AppLayout from './components/AppLayout.vue'
import HighlightLayer from './components/HighlightLayer.vue'
import { useTheme } from './theme'

const route = useRoute()
// A dashboard page shown in the Fairy workspace's panel is this app in a frame: it shows the page alone.
const embedded = window.self !== window.top
const { t } = useI18n()
const { isDark } = useTheme()
// Lets global CSS (e.g. the logo) adapt to the active theme.
watchEffect(() => document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light'))
// The shared components' own words, in the dashboard's language.
const uiText = computed(() => {
  const keys = ['on', 'off', 'enabled', 'disabled', 'clear', 'close', 'noOptions', 'add', 'remove', 'ok', 'cancel', 'loading', 'previous', 'next', 'preview'] as const
  return { ...Object.fromEntries(keys.map((key) => [key, t(`ui.${key}`)])), useValue: t('ui.useValue', { value: '{value}' }), perPage: t('ui.perPage', { n: '{n}' }) }
})
</script>

<template>
  <UiProvider :text="uiText">
    <RouterView v-if="route.meta.public || (route.meta.workspace && !embedded)" />
    <AppLayout v-else :embedded="embedded" />
    <HighlightLayer />
  </UiProvider>
</template>
