<script setup lang="ts">
import { NAlert } from 'naive-ui'
import { onBeforeUnmount, ref, watch } from 'vue'
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
    lines.value = await call<LogLine[]>('bots.logs', { id, limit: 500 })
  } catch (e) {
    lines.value = []
    error.value = t('botLogs.failed', { error: (e as Error).message })
  }
}, { immediate: true })

const off = on('bots/log', (line: LogLine) => {
  if (line.botId !== props.botId) return
  lines.value.push(line)
  if (lines.value.length > MAX) lines.value.splice(0, lines.value.length - MAX)
})
onBeforeUnmount(off)
</script>

<template>
  <NAlert v-if="error" type="warning" :show-icon="false" class="error">{{ error }}</NAlert>
  <LogViewer :lines="lines" :empty-text="t('botLogs.empty')" @clear="lines = []" />
</template>

<style scoped>
.error {
  margin-bottom: 12px;
}
</style>
