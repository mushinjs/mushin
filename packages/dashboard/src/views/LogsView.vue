<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call, on } from '../api'
import LogViewer from '../components/LogViewer.vue'
import type { LogLine } from '../types'

const { t } = useI18n()
const lines = ref<LogLine[]>([])
const MAX = 2000

onMounted(async () => {
  lines.value = await call<LogLine[]>('logs.recent', { limit: 500 })
})

const off = on('log', (line: LogLine) => {
  lines.value.push(line)
  if (lines.value.length > MAX) lines.value.splice(0, lines.value.length - MAX)
})
onBeforeUnmount(off)
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>{{ t('nav.logs') }}</h1>
        <p class="page-lead">{{ t('logs.lead') }}</p>
      </div>
    </div>
    <LogViewer :lines="lines" @clear="lines = []" />
  </div>
</template>
