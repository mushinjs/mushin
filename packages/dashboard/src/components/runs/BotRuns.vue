<script setup lang="ts">
import { OpenOutline, StopCircleOutline } from '@vicons/ionicons5'
import { NButton, NEmpty, NIcon, NSelect, NSpin, NTooltip, useDialog, useMessage } from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call } from '../../api'
import { isLive, useRunsStore } from '../../stores/runs'
import type { FlowRunInfo, FlowRunStatus } from '../../types'
import { formatTime } from '../../utils'
import { runColors, useRunText } from './useRunText'

const props = defineProps<{ botId: string }>()
const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const store = useRunsStore()
const { nodeName, userName, duration, statusText, stoppedByText } = useRunText()

const PAGE = 50
const runs = ref<FlowRunInfo[]>([])
const more = ref(false)
const loading = ref(false)
const flow = ref<string | null>(null)
const status = ref<FlowRunStatus | null>(null)
const flows = ref<{ id: string; name: string; bots: string[] }[]>([])
const now = ref(Date.now())

const flowOptions = computed(() => [
  { label: t('runs.allFlows'), value: '' },
  ...flows.value.filter((item) => item.bots.includes(props.botId)).map((item) => ({ label: item.name, value: item.id })),
])
const statusOptions = computed(() => [
  { label: t('runs.anyStatus'), value: '' },
  ...(['running', 'queued', 'error', 'stopped', 'ok'] as const).map((value) => ({ label: t(`runs.status.${value}`), value })),
])

/** Whether a run belongs in the list as filtered now. */
function shown(run: FlowRunInfo) {
  if (run.botId !== props.botId) return false
  if (flow.value && run.flowId !== flow.value) return false
  if (!status.value) return true
  return run.status === status.value || (status.value === 'running' && run.status === 'waiting')
}

async function load(append = false) {
  loading.value = true
  try {
    const last = append ? runs.value.at(-1) : undefined
    const page = await call<{ runs: FlowRunInfo[]; more: boolean }>('flows.history', {
      bot: props.botId,
      limit: PAGE,
      ...(flow.value ? { flow: flow.value } : {}),
      ...(status.value ? { status: [status.value] } : {}),
      ...(last ? { before: last.startedAt } : {}),
    })
    runs.value = append ? [...runs.value, ...page.runs] : page.runs
    more.value = page.more
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

watch([flow, status, () => props.botId], () => load())

// New runs go on top; changes to listed ones replace them in place.
const unsubscribe = store.subscribe((run) => {
  const index = runs.value.findIndex((item) => item.id === run.id)
  if (index >= 0) {
    const next = [...runs.value]
    if (shown(run)) next[index] = run
    else next.splice(index, 1)
    runs.value = next
  } else if (shown(run)) {
    runs.value = [run, ...runs.value]
  }
})
let timer: number | undefined
onMounted(() => {
  load()
  call<{ id: string; name: string; bots: string[] }[]>('flows.list').then((list) => (flows.value = list)).catch(() => {})
  timer = window.setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  unsubscribe()
  window.clearInterval(timer)
})

const elapsed = (run: FlowRunInfo) => (run.endedAt ?? now.value) - run.startedAt

function trigger(run: FlowRunInfo) {
  if (run.source !== 'message') return `${t(`runs.source.${run.source}`)} ${run.text}`
  return t('runs.saidBy', { name: userName(run), text: run.text })
}

function detail(run: FlowRunInfo) {
  if (run.status === 'stopped') return stoppedByText(run)
  if (run.status === 'error') return run.error ?? ''
  return nodeName(run)
}

function stop(run: FlowRunInfo) {
  dialog.warning({
    title: t('runs.stopTitle'),
    content: t('runs.stopConfirm', { flow: run.flowName }),
    positiveText: t('runs.stop'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await call('flows.stop', { id: run.id })
        message.success(t('runs.stopDone'))
      } catch (error) {
        message.error((error as Error).message)
      }
    },
  })
}

const open = (run: FlowRunInfo) => router.push({ path: `/flows/${run.flowId}`, query: { run: run.id } })
</script>

<template>
  <div class="runs">
    <p class="muted lead">{{ t('runs.lead') }}</p>
    <div class="toolbar">
      <NSelect :value="flow ?? ''" size="small" class="filter" :options="flowOptions" @update:value="(value: string) => (flow = value || null)" />
      <NSelect :value="status ?? ''" size="small" class="filter" :options="statusOptions" @update:value="(value: string) => (status = (value || null) as FlowRunStatus | null)" />
    </div>

    <NSpin :show="loading && !runs.length">
      <NEmpty v-if="!runs.length && !loading" :description="t('runs.empty')" class="empty" />
      <ul v-else class="list">
        <li
          v-for="run in runs"
          :key="run.id"
          class="row"
          :class="{ live: isLive(run) }"
          :style="{ '--state': runColors[run.status] }"
          tabindex="0"
          @click="open(run)"
          @keyup.enter="open(run)"
        >
          <span class="state">
            <span class="dot" />
            {{ statusText(run) }}
          </span>
          <span class="flow">{{ run.flowName }}</span>
          <span class="trigger" :title="trigger(run)">{{ trigger(run) }}</span>
          <span class="detail" :class="{ failed: run.status === 'error' || run.status === 'stopped' }" :title="detail(run)">{{ detail(run) }}</span>
          <span class="time muted">{{ formatTime(run.startedAt) }}</span>
          <span class="took muted">{{ duration(elapsed(run)) }}</span>
          <span class="actions" @click.stop>
            <NTooltip v-if="isLive(run)">
              <template #trigger>
                <NButton size="tiny" quaternary circle type="error" :aria-label="t('runs.stop')" @click="stop(run)">
                  <template #icon><NIcon><StopCircleOutline /></NIcon></template>
                </NButton>
              </template>
              {{ t('runs.stop') }}
            </NTooltip>
            <NTooltip>
              <template #trigger>
                <NButton size="tiny" quaternary circle :aria-label="t('runs.open')" @click="open(run)">
                  <template #icon><NIcon><OpenOutline /></NIcon></template>
                </NButton>
              </template>
              {{ t('runs.open') }}
            </NTooltip>
          </span>
        </li>
      </ul>
      <div v-if="more" class="more">
        <NButton size="small" :loading="loading" @click="load(true)">{{ t('runs.loadMore') }}</NButton>
      </div>
    </NSpin>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.lead {
  margin: 0 0 10px;
  font-size: 13px;
}

.spacer {
  flex: 1;
}

.filter {
  width: 160px;
}

.muted {
  opacity: 0.6;
}

.empty {
  padding: 40px 0;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row {
  display: grid;
  grid-template-columns: 92px minmax(90px, 1fr) minmax(120px, 2fr) minmax(90px, 1.4fr) 92px 72px 60px;
  align-items: center;
  gap: 12px;
  padding: 8px 10px 8px 12px;
  border-radius: 8px;
  border: 1px solid rgba(127, 127, 127, 0.16);
  border-left: 3px solid var(--state);
  font-size: 13px;
  cursor: pointer;
}

.row:hover,
.row:focus-visible {
  background: rgba(127, 127, 127, 0.07);
  outline: none;
}

.row.live {
  background: color-mix(in srgb, var(--state) 6%, transparent);
}

.state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--state);
  font-weight: 600;
  white-space: nowrap;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--state);
}

.live .dot {
  animation: pulse 1.4s ease-in-out infinite;
}

.flow {
  font-weight: 600;
}

.flow,
.trigger,
.detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail.failed {
  color: #d03050;
}

.time,
.took {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
}

.more {
  display: flex;
  justify-content: center;
  margin-top: 12px;
}

@keyframes pulse {
  50% {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--state) 25%, transparent);
  }
}

@media (max-width: 760px) {
  .row {
    grid-template-columns: 1fr auto;
    gap: 2px 8px;
  }

  .flow, .trigger, .detail { grid-column: 1 / -1; }
  .time, .took { display: none; }
  .actions { grid-row: 1; grid-column: 2; }
}

@media (prefers-reduced-motion: reduce) {
  .live .dot {
    animation: none;
  }
}
</style>
