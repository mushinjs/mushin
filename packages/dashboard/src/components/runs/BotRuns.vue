<script setup lang="ts">
import { Button, Empty, Select, Spin, Tooltip, useConfirm, useToast } from '@mushinjs/ui'
import { computed, markRaw, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call, on } from '../../api'
import { isLive, useRunsStore } from '../../stores/runs'
import type { CatalogEntry, FlowRunInfo, FlowRunStatus, LogLine, PluginRunInfo } from '../../types'
import { formatTime, localize } from '../../utils'
import { runColors, useRunText } from './useRunText'
import { flowRunRef, pluginRunRef, startRefDrag } from '../fairy/refs'

/**
 * A bot's runs, newest first: flow runs (open in the editor with their trace) and plugin runs, each message a plugin
 * replied to, kept from the plugins after it or failed on (expand one for the log lines written while handling it).
 */
const props = defineProps<{ botId: string }>()
const { t, locale } = useI18n()
const router = useRouter()
const message = useToast()
const dialog = useConfirm()
const store = useRunsStore()
const { nodeName, userName, duration, statusText, stoppedByText } = useRunText()

const PAGE = 50
const runs = ref<FlowRunInfo[]>([])
const pluginRuns = ref<PluginRunInfo[]>([])
const more = ref(false)
const pluginMore = ref(false)
const loading = ref(false)
/** `flow:<id>`, `plugin:<package>`, or everything. */
const source = ref<string | null>(null)
const status = ref<FlowRunStatus | null>(null)
const flows = ref<{ id: string; name: string; bots: string[] }[]>([])
const catalog = ref<CatalogEntry[]>([])
const now = ref(Date.now())

const flowFilter = computed(() => (source.value?.startsWith('flow:') ? source.value.slice(5) : undefined))
const pluginFilter = computed(() => (source.value?.startsWith('plugin:') ? source.value.slice(7) : undefined))
/** Plugin runs end as ok or error; the other states are only flows'. */
const wantPlugins = computed(() => !flowFilter.value && (!status.value || status.value === 'ok' || status.value === 'error'))
const wantFlows = computed(() => !pluginFilter.value)

const pluginName = (pkg: string) => localize(catalog.value.find((entry) => entry.package === pkg)?.manifest.displayName, locale.value) || pkg

const sourceOptions = computed(() => {
  const plugins = new Set(pluginRuns.value.map((run) => run.plugin))
  if (pluginFilter.value) plugins.add(pluginFilter.value)
  return [
    { label: t('runs.allSources'), value: '' },
    ...flows.value.filter((item) => item.bots.includes(props.botId)).map((item) => ({ label: t('runs.flowOption', { name: item.name }), value: `flow:${item.id}` })),
    ...[...plugins].map((pkg) => ({ label: t('runs.pluginOption', { name: pluginName(pkg) }), value: `plugin:${pkg}` })),
  ]
})
const statusOptions = computed(() => [
  { label: t('runs.anyStatus'), value: '' },
  ...(['running', 'queued', 'error', 'stopped', 'ok'] as const).map((value) => ({ label: t(`runs.status.${value}`), value })),
])

/** Whether a flow run belongs in the list as filtered now. */
function shown(run: FlowRunInfo) {
  if (run.botId !== props.botId || !wantFlows.value) return false
  if (flowFilter.value && run.flowId !== flowFilter.value) return false
  if (!status.value) return true
  return run.status === status.value || (status.value === 'running' && run.status === 'waiting')
}

function shownPlugin(run: PluginRunInfo) {
  if (run.botId !== props.botId || !wantPlugins.value) return false
  if (pluginFilter.value && run.plugin !== pluginFilter.value) return false
  return !status.value || run.status === status.value
}

async function load(append = false) {
  loading.value = true
  try {
    const lastFlow = append ? runs.value.at(-1) : undefined
    const lastPlugin = append ? pluginRuns.value.at(-1) : undefined
    const [flowPage, pluginPage] = await Promise.all([
      wantFlows.value && (!append || more.value)
        ? call<{ runs: FlowRunInfo[]; more: boolean }>('flows.history', {
          bot: props.botId,
          limit: PAGE,
          ...(flowFilter.value ? { flow: flowFilter.value } : {}),
          ...(status.value ? { status: [status.value] } : {}),
          ...(lastFlow ? { before: lastFlow.startedAt } : {}),
        }).catch(() => ({ runs: [], more: false }))
        : { runs: [], more: false },
      wantPlugins.value && (!append || pluginMore.value)
        ? call<{ runs: PluginRunInfo[]; more: boolean }>('bots.runs', {
          id: props.botId,
          limit: PAGE,
          ...(pluginFilter.value ? { plugin: pluginFilter.value } : {}),
          ...(status.value ? { status: status.value } : {}),
          ...(lastPlugin ? { before: lastPlugin.startedAt } : {}),
        })
        : { runs: [], more: false },
    ])
    runs.value = append ? [...runs.value, ...flowPage.runs] : flowPage.runs
    pluginRuns.value = append ? [...pluginRuns.value, ...pluginPage.runs] : pluginPage.runs
    more.value = flowPage.more
    pluginMore.value = pluginPage.more
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

watch([source, status, () => props.botId], () => load())

type Item = { kind: 'flow'; run: FlowRunInfo } | { kind: 'plugin'; run: PluginRunInfo }

/**
 * Both kinds, newest first. While one kind has older pages, the other's runs older than its last loaded one wait
 * for "load more", so the list has no gap.
 */
const items = computed<Item[]>(() => {
  const cutoff = Math.max(more.value ? runs.value.at(-1)?.startedAt ?? 0 : 0, pluginMore.value ? pluginRuns.value.at(-1)?.startedAt ?? 0 : 0)
  return [
    ...runs.value.map((run) => ({ kind: 'flow' as const, run })),
    ...pluginRuns.value.map((run) => ({ kind: 'plugin' as const, run })),
  ].filter((item) => item.run.startedAt >= cutoff).sort((a, b) => b.run.startedAt - a.run.startedAt)
})

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
const offRun = on('bots/run', (run: PluginRunInfo) => {
  if (shownPlugin(run)) pluginRuns.value = [run, ...pluginRuns.value]
})
let timer: number | undefined
onMounted(() => {
  load()
  call<{ id: string; name: string; bots: string[] }[]>('flows.list').then((list) => (flows.value = list)).catch(() => {})
  call<CatalogEntry[]>('plugins.catalog').then((list) => (catalog.value = list)).catch(() => {})
  timer = window.setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  unsubscribe()
  offRun()
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

/** 已回复 / 已拦下 / 出错 */
function pluginState(run: PluginRunInfo) {
  if (run.status === 'error') return t('runs.status.error')
  return run.replies ? t('runs.plugin.replied') : t('runs.plugin.kept')
}

function pluginDetail(run: PluginRunInfo) {
  if (run.status === 'error') return run.error ?? ''
  // A command that answered keeps the message as a matter of course; say so only when keeping it is all the plugin did.
  const parts = [run.command && `/${run.command}`, run.replies && t('runs.plugin.replies', run.replies), run.kept && !run.replies && t('runs.plugin.keptHint')]
  return parts.filter(Boolean).join(' · ')
}

/** A run dragged into Fairy's input goes with the next message: named by what ran and when, with its outcome. */
function dragFlowRun(event: DragEvent, run: FlowRunInfo) {
  startRefDrag(event, flowRunRef({ ...run, flowName: `${run.flowName} ${formatTime(run.startedAt)}` }, [statusText(run), trigger(run), detail(run)].filter(Boolean).join(' · ')))
}

function dragPluginRun(event: DragEvent, run: PluginRunInfo) {
  const said = t('runs.saidBy', { name: run.user.name || run.user.id, text: run.text })
  startRefDrag(event, pluginRunRef(run, `${pluginName(run.plugin)} ${formatTime(run.startedAt)}`, [pluginState(run), said, pluginDetail(run)].filter(Boolean).join(' · ')))
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

/** The plugin run whose log lines are showing, and those lines. */
const expanded = ref<string>()
const lines = ref<LogLine[]>([])
const linesLoading = ref(false)

async function toggleLines(run: PluginRunInfo) {
  if (expanded.value === run.id) {
    expanded.value = undefined
    return
  }
  expanded.value = run.id
  lines.value = []
  linesLoading.value = true
  try {
    const found = await call<LogLine[]>('bots.logs', { id: props.botId, message: run.message, limit: 100 })
    if (expanded.value === run.id) lines.value = found.map((line) => markRaw(line))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    linesLoading.value = false
  }
}
</script>

<template>
  <div class="runs">
    <p class="muted lead">{{ t('runs.lead') }}</p>
    <div class="toolbar">
      <Select :value="source ?? ''" size="small" class="filter wide" :options="sourceOptions" @update:value="(value: string) => (source = value || null)" />
      <Select :value="status ?? ''" size="small" class="filter" :options="statusOptions" @update:value="(value: string) => (status = (value || null) as FlowRunStatus | null)" />
    </div>

    <Spin :show="loading && !items.length">
      <Empty v-if="!items.length && !loading" :description="t('runs.empty')" class="empty" />
      <ul v-else class="list">
        <template v-for="item in items" :key="`${item.kind}:${item.run.id}`">
          <li
            v-if="item.kind === 'flow'"
            class="row"
            :class="{ live: isLive(item.run) }"
            :style="{ '--state': runColors[item.run.status] }"
            tabindex="0"
            draggable="true"
            @dragstart="dragFlowRun($event, item.run)"
            @click="open(item.run)"
            @keyup.enter="open(item.run)"
          >
            <span class="state">
              <span class="dot" />
              {{ statusText(item.run) }}
            </span>
            <span class="flow" :title="item.run.flowName"><span class="i-lucide-network kind-icon" />{{ item.run.flowName }}</span>
            <span class="trigger" :title="trigger(item.run)">{{ trigger(item.run) }}</span>
            <span class="detail" :class="{ failed: item.run.status === 'error' || item.run.status === 'stopped' }" :title="detail(item.run)">{{ detail(item.run) }}</span>
            <span class="time muted">{{ formatTime(item.run.startedAt) }}</span>
            <span class="took muted">{{ duration(elapsed(item.run)) }}</span>
            <span class="actions" @click.stop>
              <Tooltip v-if="isLive(item.run)">
                <template #trigger>
                  <Button size="tiny" quaternary circle type="error" :aria-label="t('runs.stop')" icon="i-lucide-circle-stop" @click="stop(item.run)" />
                </template>
                {{ t('runs.stop') }}
              </Tooltip>
              <Tooltip>
                <template #trigger>
                  <Button size="tiny" quaternary circle :aria-label="t('runs.open')" icon="i-lucide-external-link" @click="open(item.run)" />
                </template>
                {{ t('runs.open') }}
              </Tooltip>
            </span>
          </li>
          <li
            v-else
            class="row plugin"
            :class="{ open: expanded === item.run.id }"
            :style="{ '--state': runColors[item.run.status] }"
            tabindex="0"
            draggable="true"
            :aria-expanded="expanded === item.run.id"
            @dragstart="dragPluginRun($event, item.run)"
            @click="toggleLines(item.run)"
            @keyup.enter="toggleLines(item.run)"
          >
            <span class="state">
              <span class="dot" />
              {{ pluginState(item.run) }}
            </span>
            <span class="flow" :title="item.run.plugin"><span class="i-lucide-puzzle kind-icon" />{{ pluginName(item.run.plugin) }}</span>
            <span class="trigger" :title="item.run.text">{{ t('runs.saidBy', { name: item.run.user.name || item.run.user.id, text: item.run.text }) }}</span>
            <span class="detail" :class="{ failed: item.run.status === 'error' }" :title="pluginDetail(item.run)">{{ pluginDetail(item.run) }}</span>
            <span class="time muted">{{ formatTime(item.run.startedAt) }}</span>
            <span class="took muted">{{ duration(item.run.ms) }}</span>
            <span class="actions" @click.stop>
              <Tooltip>
                <template #trigger>
                  <Button size="tiny" quaternary circle :aria-label="t('runs.plugin.logs')" icon="i-lucide-scroll-text" @click="toggleLines(item.run)" />
                </template>
                {{ t('runs.plugin.logs') }}
              </Tooltip>
            </span>
            <div v-if="expanded === item.run.id" class="lines" @click.stop>
              <p v-if="linesLoading" class="muted">{{ t('runs.plugin.loading') }}</p>
              <p v-else-if="!lines.length" class="muted">{{ t('runs.plugin.noLines') }}</p>
              <pre v-else class="mono">{{ lines.map((line) => `${formatTime(line.ts)}  ${line.text}`).join('\n') }}</pre>
            </div>
          </li>
        </template>
      </ul>
      <div v-if="more || pluginMore" class="more">
        <Button size="small" :loading="loading" @click="load(true)">{{ t('runs.loadMore') }}</Button>
      </div>
    </Spin>
  </div>
</template>

<style scoped>
/* The list is narrower than the window when Fairy's panel is open: rows fold by the list's own width. */
.runs {
  container: runs / inline-size;
}

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

.filter.wide {
  width: 220px;
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
  /* The time column fits its text: dates from earlier days are wider than today's "11:42". */
  grid-template-columns: 92px minmax(90px, 1fr) minmax(120px, 2fr) minmax(90px, 1.4fr) max-content 64px 60px;
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
  color: var(--bad);
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

.kind-icon {
  margin-right: 5px;
  font-size: 12px;
  vertical-align: -1px;
  opacity: 0.55;
}

.lines {
  grid-column: 1 / -1;
  margin-top: 6px;
  cursor: auto;
}

.lines p {
  margin: 0;
  font-size: 12px;
}

.lines pre {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.08);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
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

@container runs (max-width: 700px) {
  .row {
    grid-template-columns: 76px minmax(0, 1fr) max-content auto;
    gap: 2px 10px;
  }

  .trigger { grid-column: 2 / 4; grid-row: 2; }
  .detail { grid-column: 2 / 4; grid-row: 3; }
  .detail:empty { display: none; }
  .took { display: none; }
  .actions { grid-row: 1; grid-column: 4; }
}

@media (prefers-reduced-motion: reduce) {
  .live .dot {
    animation: none;
  }
}
</style>
