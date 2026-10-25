<script setup lang="ts">
import { NCard, NEmpty, NRadioButton, NRadioGroup, NTag, useMessage } from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { call, on } from '../api'
import EChart, { type ChartOption } from '../components/EChart.vue'
import { useAgentStore } from '../stores/agent'
import type { FlowSummary, LogLine, PerfSample, StatsOverview, StatsSeries, StatsTopRow } from '../types'
import { formatTime } from '../utils'

const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const agent = useAgentStore()

type Range = '24h' | '7d'
type Dimension = 'channels' | 'users' | 'commands' | 'flows' | 'llm'

const overview = ref<StatsOverview>()
const range = ref<Range>('24h')
const activity = ref<StatsSeries>()
const dimension = ref<Dimension>('channels')
const ranking = ref<StatsTopRow[]>([])
const samples = ref<PerfSample[]>([])
const flows = ref<FlowSummary[]>([])
const errors = ref<LogLine[]>([])
const unavailable = ref(false)

const hours = computed(() => (range.value === '24h' ? 24 : 168))
const days = computed(() => (range.value === '24h' ? 1 : 7))

async function refreshOverview() {
  try {
    overview.value = await call<StatsOverview>('stats.overview')
    unavailable.value = false
  } catch (error) {
    // The statistics plugin may be turned off; the rest of the page still works.
    unavailable.value = (error as { code?: string }).code === 'not_found'
    if (!unavailable.value) message.error((error as Error).message)
  }
}

async function refreshActivity() {
  activity.value = await call<StatsSeries>('stats.series', { metric: 'messages', hours: hours.value }).catch(() => undefined)
}

async function refreshRanking() {
  ranking.value = await call<StatsTopRow[]>('stats.top', { dimension: dimension.value, days: days.value, limit: 8 }).catch(() => [])
}

async function refreshShortcuts() {
  const [flowList, logs] = await Promise.all([
    call<FlowSummary[]>('flows.list').catch(() => []),
    call<LogLine[]>('logs.recent', { limit: 300 }).catch(() => []),
  ])
  flows.value = [...flowList].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4)
  errors.value = logs.filter((line) => line.type === 'error' || line.type === 'warn').slice(-4).reverse()
}

onMounted(async () => {
  agent.refreshSessions().catch(() => {})
  await Promise.all([refreshOverview(), refreshActivity(), refreshRanking(), refreshShortcuts()])
  samples.value = await call<PerfSample[]>('stats.performance').catch(() => [])
})

watch(range, () => Promise.all([refreshActivity(), refreshRanking()]))
watch(dimension, refreshRanking)

// Counts change with every message; refresh them now and then rather than on each event.
const timer = setInterval(() => {
  refreshOverview()
  refreshActivity()
}, 30_000)
const offs = [
  on('stats/sample', (sample: PerfSample) => {
    samples.value = [...samples.value.slice(-719), sample]
    if (overview.value) overview.value = { ...overview.value, sample }
  }),
  on('bots/status', refreshOverview),
  on('flows/changed', () => Promise.all([refreshOverview(), refreshShortcuts()])),
]
onBeforeUnmount(() => {
  clearInterval(timer)
  offs.forEach((off) => off())
})

const number = (value: number) => value.toLocaleString()
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0)} MB`

function duration(seconds: number) {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d ? t('overview.daysHours', { d, h }) : h ? t('overview.hoursMinutes', { h, m }) : t('overview.minutes', { m })
}

const cards = computed(() => {
  const value = overview.value
  if (!value) return []
  return [
    { key: 'bots', label: t('overview.botsOnline'), value: `${value.bots.online} / ${value.bots.total}`, to: '/bots' },
    { key: 'messages', label: t('overview.messagesToday'), value: `${number(value.today.received)} / ${number(value.today.sent)}`, hint: t('overview.receivedSent') },
    { key: 'tokens', label: t('overview.tokensToday'), value: number(value.today.llmTokens), hint: t('overview.llmCalls', { n: value.today.llmCalls }) },
    { key: 'flows', label: t('overview.flows'), value: number(value.flows.total), hint: value.flows.withErrors ? t('overview.flowsWithErrors', { n: value.flows.withErrors }) : t('overview.flowRuns', { n: value.today.flowRuns }), danger: value.flows.withErrors > 0, to: '/flows' },
    { key: 'commands', label: t('overview.commands'), value: number(value.commands), hint: t('overview.commandCalls', { n: value.today.commands }) },
    { key: 'providers', label: t('overview.providers'), value: number(value.providers.total), hint: t('overview.providersPassed', { n: value.providers.passed }), to: '/providers' },
    { key: 'appPlugins', label: t('overview.appPlugins'), value: `${value.appPlugins.enabled} / ${value.appPlugins.total}`, to: '/plugins' },
    { key: 'botPlugins', label: t('overview.botPlugins'), value: number(value.botPlugins.enabled), hint: t('overview.acrossBots') },
  ]
})

const axisTime = (time: number, granularity: 'hour' | 'day') => {
  const date = new Date(time)
  return granularity === 'day'
    ? `${date.getMonth() + 1}/${date.getDate()}`
    : `${String(date.getHours()).padStart(2, '0')}:00`
}

const grid = { left: 44, right: 16, top: 36, bottom: 28 }

const activityOption = computed<ChartOption>(() => {
  const data = activity.value
  return {
    grid,
    tooltip: { trigger: 'axis' },
    legend: { top: 0, type: 'scroll' },
    xAxis: { type: 'category', boundaryGap: false, data: data?.points.map((point) => axisTime(point.t, data.granularity)) ?? [] },
    yAxis: { type: 'value', minInterval: 1 },
    series: (data?.series ?? []).map((series) => ({
      name: series.name,
      type: 'line',
      smooth: true,
      showSymbol: false,
      areaStyle: { opacity: 0.08 },
      data: data!.points.map((point) => point.values[series.key] ?? 0),
    })),
  }
})

const performanceOption = computed<ChartOption>(() => {
  const list = samples.value
  const time = (sample: PerfSample) => new Date(sample.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return {
    grid: { ...grid, right: 56 },
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    xAxis: { type: 'category', boundaryGap: false, data: list.map(time) },
    yAxis: [
      { type: 'value', name: 'CPU %', min: 0, nameTextStyle: { align: 'left' } },
      { type: 'value', name: 'MB', min: 0, splitLine: { show: false } },
    ],
    series: [
      { name: 'CPU', type: 'line', showSymbol: false, data: list.map((sample) => sample.cpu) },
      { name: 'RSS', type: 'line', yAxisIndex: 1, showSymbol: false, data: list.map((sample) => Math.round(sample.rss / 1048576)) },
      { name: t('overview.heap'), type: 'line', yAxisIndex: 1, showSymbol: false, data: list.map((sample) => Math.round(sample.heapUsed / 1048576)) },
    ],
  }
})

const dimensions = computed(() => [
  { value: 'channels', label: t('overview.rankChannels') },
  { value: 'users', label: t('overview.rankUsers') },
  { value: 'commands', label: t('overview.rankCommands') },
  { value: 'flows', label: t('overview.rankFlows') },
  { value: 'llm', label: t('overview.rankModels') },
])

const maxCount = computed(() => Math.max(1, ...ranking.value.map((row) => row.count)))

function rankDetail(row: StatsTopRow) {
  if (dimension.value === 'flows') return row.errors ? t('overview.failedRuns', { n: row.errors }) : ''
  if (dimension.value === 'llm') return t('overview.tokens', { n: number(row.tokens ?? 0) })
  return row.bot ?? ''
}

function openSession(id: string) {
  agent.open = true
  agent.load(id).catch(() => {})
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>{{ t('nav.overview') }}</h1>
        <p class="page-lead">{{ t('overview.lead') }}</p>
      </div>
    </div>

    <p v-if="unavailable" class="muted">{{ t('overview.unavailable') }}</p>

    <div class="cards">
      <component
        :is="card.to ? RouterLink : 'div'"
        v-for="card in cards"
        :key="card.key"
        :to="card.to"
        class="stat"
        :class="{ link: !!card.to }"
        :data-agent-target="`overview.${card.key}`"
      >
        <div class="stat-label">{{ card.label }}</div>
        <div class="stat-value">{{ card.value }}</div>
        <div v-if="card.hint" class="stat-hint" :class="{ danger: card.danger }">{{ card.hint }}</div>
      </component>
    </div>

    <div class="row">
      <NCard :title="t('overview.activity')" class="wide" data-agent-target="overview.activity">
        <template #header-extra>
          <NRadioGroup v-model:value="range" size="small">
            <NRadioButton value="24h">{{ t('overview.last24h') }}</NRadioButton>
            <NRadioButton value="7d">{{ t('overview.last7d') }}</NRadioButton>
          </NRadioGroup>
        </template>
        <EChart v-if="activity?.series.length" :option="activityOption" :height="260" />
        <NEmpty v-else :description="t('overview.noMessages')" class="empty" />
      </NCard>

      <NCard :title="t('overview.ranking')" class="narrow" data-agent-target="overview.ranking">
        <NRadioGroup v-model:value="dimension" size="small" class="rank-tabs">
          <NRadioButton v-for="item in dimensions" :key="item.value" :value="item.value">{{ item.label }}</NRadioButton>
        </NRadioGroup>
        <div v-if="ranking.length" class="ranks">
          <div v-for="(row, index) in ranking" :key="row.key" class="rank">
            <span class="rank-no">{{ index + 1 }}</span>
            <div class="rank-body">
              <div class="rank-line">
                <span class="rank-name" :title="row.id && row.id !== row.name ? row.id : undefined">{{ row.name }}</span>
                <span class="rank-count">{{ number(row.count) }}</span>
              </div>
              <div class="rank-bar"><span :style="{ width: `${(row.count / maxCount) * 100}%` }" /></div>
              <div v-if="rankDetail(row)" class="rank-detail">{{ rankDetail(row) }}</div>
            </div>
          </div>
        </div>
        <NEmpty v-else :description="t('overview.noData')" class="empty" />
      </NCard>
    </div>

    <div class="row">
      <NCard :title="t('overview.performance')" class="wide" data-agent-target="overview.performance">
        <template #header-extra>
          <span v-if="overview?.sample" class="muted small">
            {{ t('overview.loopDelay', { mean: overview.sample.loopMean, max: overview.sample.loopMax }) }}
          </span>
        </template>
        <EChart v-if="samples.length" :option="performanceOption" :height="220" />
        <NEmpty v-else :description="t('overview.sampling')" class="empty" />
      </NCard>

      <NCard :title="t('overview.system')" class="narrow" data-agent-target="overview.system">
        <dl v-if="overview" class="facts">
          <dt>Mushin.js</dt><dd>{{ overview.versions.mushin ?? '—' }}</dd>
          <dt>Node.js</dt><dd>{{ overview.versions.node }}</dd>
          <dt>Cordis</dt><dd>{{ overview.versions.cordis ?? '—' }}</dd>
          <dt>{{ t('overview.platform') }}</dt><dd>{{ overview.platform }}</dd>
          <dt>{{ t('overview.uptime') }}</dt><dd>{{ duration(overview.uptime) }}</dd>
          <dt>{{ t('overview.dataSize') }}</dt><dd>{{ mb(overview.dataBytes) }}</dd>
          <template v-if="overview.sample">
            <dt>{{ t('overview.memory') }}</dt><dd>{{ mb(overview.sample.rss) }}</dd>
          </template>
        </dl>
        <details v-if="overview" class="plugins">
          <summary>{{ t('overview.pluginVersions', { n: overview.versions.plugins.length }) }}</summary>
          <div v-for="plugin in overview.versions.plugins" :key="plugin.package" class="plugin">
            <span class="mono">{{ plugin.package }}</span>
            <span class="muted">{{ plugin.version ?? '—' }}<NTag v-if="!plugin.enabled" size="tiny" :bordered="false" class="off">{{ t('overview.off') }}</NTag></span>
          </div>
        </details>
      </NCard>
    </div>

    <div class="shortcuts">
      <NCard :title="t('overview.recentChats')" size="small">
        <button v-for="session in agent.sessions.slice(0, 4)" :key="session.id" type="button" class="shortcut" @click="openSession(session.id)">
          <span class="shortcut-name">{{ session.title || t('overview.untitled') }}</span>
          <span class="muted small">{{ formatTime(session.updatedAt) }}</span>
        </button>
        <p v-if="!agent.sessions.length" class="muted small">{{ t('overview.noChats') }}</p>
      </NCard>
      <NCard :title="t('overview.recentFlows')" size="small">
        <button v-for="flow in flows" :key="flow.id" type="button" class="shortcut" @click="router.push(`/flows/${flow.id}`)">
          <span class="shortcut-name">{{ flow.name }}</span>
          <span class="small" :class="flow.errors ? 'danger' : 'muted'">{{ flow.errors ? t('overview.flowErrors', { n: flow.errors }) : formatTime(flow.updatedAt) }}</span>
        </button>
        <p v-if="!flows.length" class="muted small">{{ t('overview.noFlows') }}</p>
      </NCard>
      <NCard :title="t('overview.recentErrors')" size="small">
        <button v-for="line in errors" :key="line.sn" type="button" class="shortcut" @click="router.push('/logs')">
          <span class="shortcut-name" :class="line.type === 'error' ? 'danger' : 'warn'">{{ line.text }}</span>
          <span class="muted small">{{ formatTime(line.ts) }}</span>
        </button>
        <p v-if="!errors.length" class="muted small">{{ t('overview.noErrors') }}</p>
      </NCard>
    </div>
  </div>
</template>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.stat {
  display: block;
  padding: 14px 16px;
  border-radius: 8px;
  border: 1px solid rgba(127, 127, 127, 0.2);
  color: inherit;
  text-decoration: none;
  min-width: 0;
}

.stat.link:hover {
  border-color: rgba(127, 127, 127, 0.45);
}

.stat-label {
  font-size: 13px;
  opacity: 0.7;
}

.stat-value {
  margin-top: 6px;
  font-size: 24px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.stat-hint {
  margin-top: 2px;
  font-size: 12px;
  opacity: 0.65;
}

.danger {
  color: #d03050;
  opacity: 1;
}

.warn {
  color: #d08a00;
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}

@media (max-width: 900px) {
  .row {
    grid-template-columns: minmax(0, 1fr);
  }
}

.empty {
  padding: 48px 0;
}

.rank-tabs {
  display: flex;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.ranks {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rank {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.rank-no {
  width: 18px;
  font-size: 12px;
  opacity: 0.6;
  text-align: right;
  font-variant-numeric: tabular-nums;
  line-height: 20px;
}

.rank-body {
  flex: 1;
  min-width: 0;
}

.rank-line {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  line-height: 20px;
}

.rank-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rank-count {
  font-variant-numeric: tabular-nums;
}

.rank-bar {
  height: 4px;
  border-radius: 2px;
  background: rgba(127, 127, 127, 0.15);
  overflow: hidden;
}

.rank-bar span {
  display: block;
  height: 100%;
  background: #2080f0;
}

.rank-detail {
  margin-top: 2px;
  font-size: 12px;
  opacity: 0.6;
}

.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 16px;
  margin: 0;
  font-size: 13px;
}

.facts dt {
  opacity: 0.65;
}

.facts dd {
  margin: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.plugins {
  margin-top: 14px;
  font-size: 13px;
}

.plugins summary {
  cursor: pointer;
  opacity: 0.8;
  margin-bottom: 6px;
}

.plugin {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0;
}

.plugin .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.off {
  margin-left: 6px;
}

.shortcuts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}

.shortcut {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  padding: 6px 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.shortcut:hover .shortcut-name {
  text-decoration: underline;
}

.shortcut-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.muted {
  opacity: 0.65;
}

.small {
  font-size: 12px;
  white-space: nowrap;
}
</style>
