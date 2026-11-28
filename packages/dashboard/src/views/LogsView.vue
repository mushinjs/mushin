<script setup lang="ts">
import { Checkbox } from '@mushinjs/ui'
import { computed, markRaw, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { call, on, setDebugLogs } from '../api'
import PageHeader from '../components/PageHeader.vue'
import LogViewer from '../components/LogViewer.vue'
import { prefs } from '../prefs'
import type { LogLine } from '../types'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const lines = ref<LogLine[]>([])
/** /logs?plugin=<package>: only what that plugin wrote, as linked from its panel on the Plugins page. */
const plugin = computed(() => (typeof route.query.plugin === 'string' ? route.query.plugin : undefined))
const shown = computed(() => (plugin.value ? lines.value.filter((line) => line.plugin === plugin.value) : lines.value))
const MAX = 2000

async function load() {
  const input = { limit: 500, ...(prefs.logDebug ? { level: 'debug' } : {}), ...(plugin.value ? { plugin: plugin.value } : {}) }
  lines.value = (await call<LogLine[]>('logs.recent', input)).map((line) => markRaw(line))
}

onMounted(() => {
  // Debug lines are sent only to tabs that ask, and only while this page is open.
  if (prefs.logDebug) setDebugLogs(true)
  load()
})

watch(plugin, () => load())

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
    <div v-if="plugin" class="filter">
      <span class="chip">{{ t('logs.pluginFilter', { name: plugin }) }}<button type="button" class="x" :aria-label="t('common.close')" @click="router.replace({ query: { ...route.query, plugin: undefined } })"><span class="i-lucide-x" /></button></span>
    </div>
    <LogViewer :lines="shown" height="max(320px, calc(100vh - 320px))" @clear="lines = []">
      <template #tools>
        <Checkbox v-model:checked="prefs.logDebug" size="small" :title="t('logs.debugHint')">{{ t('logs.debug') }}</Checkbox>
      </template>
    </LogViewer>
  </div>
</template>

<style scoped>
.filter {
  margin-bottom: 10px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 4px 0 10px;
  border-radius: 13px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 12.5px;
}

.x {
  display: inline-flex;
  padding: 2px;
  border: none;
  border-radius: 50%;
  background: none;
  color: inherit;
  cursor: pointer;
}
</style>
