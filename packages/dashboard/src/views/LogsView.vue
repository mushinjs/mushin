<script setup lang="ts">
import { NButton, NCard, NInput, NRadioButton, NRadioGroup, NSpace, NSwitch } from 'naive-ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call, on } from '../api'
import type { LogLine } from '../types'

const { t } = useI18n()
const lines = ref<LogLine[]>([])
const level = ref<'all' | 'warn' | 'error'>('all')
const query = ref('')
const follow = ref(true)
const box = ref<HTMLElement>()

const MAX = 2000
const rank: Record<string, number> = { error: 3, warn: 2, info: 1, debug: 0 }

const visible = computed(() => {
  const min = level.value === 'error' ? 3 : level.value === 'warn' ? 2 : 0
  const needle = query.value.toLowerCase()
  return lines.value.filter((line) => (rank[line.type] ?? 1) >= min
    && (!needle || `${line.name} ${line.text}`.toLowerCase().includes(needle)))
})

async function scroll() {
  if (!follow.value) return
  await nextTick()
  box.value?.scrollTo({ top: box.value.scrollHeight })
}

onMounted(async () => {
  lines.value = await call<LogLine[]>('logs.recent', { limit: 500 })
  scroll()
})

const off = on('log', (line: LogLine) => {
  lines.value.push(line)
  if (lines.value.length > MAX) lines.value.splice(0, lines.value.length - MAX)
  scroll()
})
onBeforeUnmount(off)

function time(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour12: false })
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>{{ t('nav.logs') }}</h1>
        <p class="page-lead">{{ t('logs.lead') }}</p>
      </div>
      <NSpace align="center">
        <NInput v-model:value="query" size="small" clearable :placeholder="t('logs.filter')" style="width: 180px" />
        <NRadioGroup v-model:value="level" size="small">
          <NRadioButton value="all">{{ t('logs.all') }}</NRadioButton>
          <NRadioButton value="warn">{{ t('logs.warnings') }}</NRadioButton>
          <NRadioButton value="error">{{ t('logs.errors') }}</NRadioButton>
        </NRadioGroup>
        <NSwitch v-model:value="follow" size="small">
          <template #checked>{{ t('logs.follow') }}</template>
          <template #unchecked>{{ t('logs.follow') }}</template>
        </NSwitch>
        <NButton size="small" quaternary @click="lines = []">{{ t('logs.clear') }}</NButton>
      </NSpace>
    </div>
    <NCard content-style="padding: 0">
      <div ref="box" class="logs mono" role="log" aria-live="polite">
        <div v-for="line in visible" :key="line.sn" class="line" :class="line.type">
          <span class="time">{{ time(line.ts) }}</span>
          <span class="level">{{ line.type.slice(0, 1).toUpperCase() }}</span>
          <span class="name">{{ line.name }}</span>
          <span class="text">{{ line.text }}</span>
        </div>
        <div v-if="!visible.length" class="empty">{{ t('logs.empty') }}</div>
      </div>
    </NCard>
  </div>
</template>

<style scoped>
.logs {
  height: min(70vh, 760px);
  overflow: auto;
  padding: 12px 16px;
  font-size: 12px;
  line-height: 1.7;
}

.line {
  display: flex;
  gap: 10px;
  white-space: pre-wrap;
  word-break: break-word;
}

.time,
.level,
.name {
  flex: none;
  opacity: 0.55;
}

.name {
  min-width: 80px;
  opacity: 0.75;
}

.text {
  flex: 1;
}

.line.warn .level,
.line.warn .text {
  color: #f0a020;
  opacity: 1;
}

.line.error .level,
.line.error .text {
  color: #d03050;
  opacity: 1;
}

.empty {
  opacity: 0.5;
  padding: 24px 0;
  text-align: center;
}
</style>
