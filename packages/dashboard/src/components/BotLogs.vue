<script setup lang="ts">
import { Alert } from '@mushin/ui'
import { markRaw, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call, on } from '../api'
import type { LogLine } from '../types'
import LogViewer from './LogViewer.vue'

const props = defineProps<{ botId: string }>()
const { t } = useI18n()
const lines = ref<LogLine[]>([])
const error = ref('')
const MAX = 1000

watch(() => props.botId, async (id) => {
  error.value = ''
  try {
    lines.value = (await call<LogLine[]>('bots.logs', { id, limit: 500 })).map((line) => markRaw(line))
  } catch (e) {
    lines.value = []
    error.value = t('botLogs.failed', { error: (e as Error).message })
  }
}, { immediate: true })

const off = on('bots/log', (line: LogLine) => {
  if (line.botId !== props.botId) return
  // Lines never change once written; skipping deep reactivity keeps long logs cheap.
  lines.value.push(markRaw(line))
  if (lines.value.length > MAX) lines.value.splice(0, lines.value.length - MAX)
})
onBeforeUnmount(off)
</script>

<template>
  <Alert v-if="error" type="warning" :show-icon="false" class="error">{{ error }}</Alert>
  <LogViewer :lines="lines" :empty-text="t('botLogs.empty')" @clear="lines = []" />
</template>

<style scoped>
.error {
  margin-bottom: 12px;
}
</style>
