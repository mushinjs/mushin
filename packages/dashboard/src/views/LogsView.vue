<script setup lang="ts">
import { markRaw, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call, on } from '../api'
import PageHeader from '../components/PageHeader.vue'
import LogViewer from '../components/LogViewer.vue'
import type { LogLine } from '../types'

const { t } = useI18n()
const lines = ref<LogLine[]>([])
const MAX = 2000

onMounted(async () => {
  lines.value = (await call<LogLine[]>('logs.recent', { limit: 500 })).map((line) => markRaw(line))
})

const off = on('log', (line: LogLine) => {
  // Lines never change once written; skipping deep reactivity keeps long logs cheap.
  lines.value.push(markRaw(line))
  if (lines.value.length > MAX) lines.value.splice(0, lines.value.length - MAX)
})
onBeforeUnmount(off)
</script>

<template>
  <div class="page">
    <PageHeader :title="t('nav.logs')" :lead="t('logs.lead')" />
    <LogViewer :lines="lines" height="max(320px, calc(100vh - 320px))" @clear="lines = []" />
  </div>
</template>
