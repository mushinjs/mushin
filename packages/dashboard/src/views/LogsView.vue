<script setup lang="ts">
import { Checkbox } from '@mushinjs/ui'
import { markRaw, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call, on, setDebugLogs } from '../api'
import PageHeader from '../components/PageHeader.vue'
import LogViewer from '../components/LogViewer.vue'
import { prefs } from '../prefs'
import type { LogLine } from '../types'

const { t } = useI18n()
const lines = ref<LogLine[]>([])
const MAX = 2000

async function load() {
  const input = prefs.logDebug ? { limit: 500, level: 'debug' } : { limit: 500 }
  lines.value = (await call<LogLine[]>('logs.recent', input)).map((line) => markRaw(line))
}

onMounted(() => {
  // Debug lines are sent only to tabs that ask, and only while this page is open.
  if (prefs.logDebug) setDebugLogs(true)
  load()
})

watch(() => prefs.logDebug, (debug) => {
  setDebugLogs(debug)
  if (debug) load()
  else lines.value = lines.value.filter((line) => line.type !== 'debug')
})

const off = on('log', (line: LogLine) => {
  // Lines never change once written; skipping deep reactivity keeps long logs cheap.
  lines.value.push(markRaw(line))
  if (lines.value.length > MAX) lines.value.splice(0, lines.value.length - MAX)
})
onBeforeUnmount(() => {
  off()
  if (prefs.logDebug) setDebugLogs(false)
})
</script>

<template>
  <div class="page">
    <PageHeader :title="t('nav.logs')" :lead="t('logs.lead')" />
    <LogViewer :lines="lines" height="max(320px, calc(100vh - 320px))" @clear="lines = []">
      <template #tools>
        <Checkbox v-model:checked="prefs.logDebug" size="small" :title="t('logs.debugHint')">{{ t('logs.debug') }}</Checkbox>
      </template>
    </LogViewer>
  </div>
</template>
