<script setup lang="ts">
import { dateEnUS, dateZhCN, enUS, NConfigProvider, NDialogProvider, NGlobalStyle, NMessageProvider, zhCN } from 'naive-ui'
import { computed, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import AppLayout from './components/AppLayout.vue'
import HighlightLayer from './components/HighlightLayer.vue'
import { useTheme } from './theme'

const route = useRoute()
const { locale } = useI18n()
const { theme, overrides, isDark } = useTheme()
// Lets global CSS (e.g. the logo) adapt to the active theme.
watchEffect(() => document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light'))
const isChinese = computed(() => locale.value.startsWith('zh'))
</script>

<template>
  <NConfigProvider
    :theme="theme"
    :theme-overrides="overrides"
    :locale="isChinese ? zhCN : enUS"
    :date-locale="isChinese ? dateZhCN : dateEnUS"
  >
    <NGlobalStyle />
    <NMessageProvider>
      <NDialogProvider>
        <RouterView v-if="route.meta.public" />
        <AppLayout v-else />
        <HighlightLayer />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
