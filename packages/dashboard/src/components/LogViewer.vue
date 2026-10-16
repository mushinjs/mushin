<script setup lang="ts">
import { NButton, NCard, NInput, NRadioButton, NRadioGroup, NSpace, NSwitch } from 'naive-ui'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { LogLine } from '../types'

const props = defineProps<{ lines: LogLine[]; emptyText?: string }>()
const emit = defineEmits<{ clear: [] }>()

const { t } = useI18n()
const level = ref<'all' | 'info' | 'warn' | 'error'>('all')
const query = ref('')
const follow = ref(true)
const box = ref<HTMLElement>()

const rank: Record<string, number> = { error: 3, warn: 2, info: 1, debug: 0 }
const minimum = { all: 0, info: 1, warn: 2, error: 3 }
const hasDebug = computed(() => props.lines.some((line) => line.type === 'debug'))

const visible = computed(() => {
  const min = minimum[level.value]
  const needle = query.value.toLowerCase()
  return props.lines.filter((line) => (rank[line.type] ?? 1) >= min
    && (!needle || `${line.name} ${line.text}`.toLowerCase().includes(needle)))
})

async function scroll() {
  if (!follow.value) return
  await nextTick()
  box.value?.scrollTo({ top: box.value.scrollHeight })
}

onMounted(scroll)
watch(() => props.lines.length, scroll)

function time(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour12: false })
}
</script>

<template>
  <div>
    <NSpace align="center" class="toolbar">
      <NInput v-model:value="query" size="small" clearable :placeholder="t('logs.filter')" style="width: 180px" />
      <NRadioGroup v-model:value="level" size="small">
        <NRadioButton value="all">{{ t('logs.all') }}</NRadioButton>
        <NRadioButton v-if="hasDebug" value="info">{{ t('logs.noDebug') }}</NRadioButton>
        <NRadioButton value="warn">{{ t('logs.warnings') }}</NRadioButton>
        <NRadioButton value="error">{{ t('logs.errors') }}</NRadioButton>
      </NRadioGroup>
      <NSwitch v-model:value="follow" size="small">
        <template #checked>{{ t('logs.follow') }}</template>
        <template #unchecked>{{ t('logs.follow') }}</template>
      </NSwitch>
      <NButton size="small" quaternary @click="emit('clear')">{{ t('logs.clear') }}</NButton>
    </NSpace>
    <NCard content-style="padding: 0">
      <div ref="box" class="logs mono" role="log" aria-live="polite">
        <div v-for="line in visible" :key="line.sn" class="line" :class="line.type">
          <span class="time">{{ time(line.ts) }}</span>
          <span class="level">{{ line.type.slice(0, 1).toUpperCase() }}</span>
          <span class="name">{{ line.name }}</span>
          <span class="text">{{ line.text }}</span>
        </div>
        <div v-if="!visible.length" class="empty">{{ emptyText ?? t('logs.empty') }}</div>
      </div>
    </NCard>
  </div>
</template>

<style scoped>
.toolbar {
  margin-bottom: 12px;
}

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

.line.debug .text {
  opacity: 0.6;
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
  padding: 24px 16px;
  text-align: center;
}
</style>
