<script setup lang="ts">
import {
  AlertCircleOutline, ChatbubblesOutline, ChevronDownOutline, ChevronForwardOutline, FlashOutline, GitNetworkOutline, KeyOutline, SparklesOutline,
} from '@vicons/ionicons5'
import { NButton, NEmpty, NIcon, NRadioButton, NRadioGroup, NSelect, useMessage } from 'naive-ui'
import { type Component, computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call, on } from '../api'
import EChart, { type ChartOption } from '../components/EChart.vue'
import PageHeader from '../components/PageHeader.vue'
import { useAgentStore } from '../stores/agent'
import { useDataStore } from '../stores/data'
import { chartColors, palettes, useTheme } from '../theme'
import type { FlowSummary, LogLine, PerfSample, StatsOverview, StatsSeries, StatsTopRow } from '../types'
import { formatTime } from '../utils'

const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const agent = useAgentStore()
const data = useDataStore()
const { isDark } = useTheme()

type Range = '24h' | '7d'
type Dimension = 'channels' | 'users' | 'commands' | 'flows' | 'llm'

const overview = ref<StatsOverview>()
const range = ref<Range>('24h')
const activity = ref<StatsSeries>()
const dimension = ref<Dimension>('channels')
const ranking = ref<StatsTopRow[]>([])
const samples = ref<PerfSample[]>([])
const allFlows = ref<FlowSummary[]>([])
const errors = ref<LogLine[]>([])
const unavailable = ref(false)
/** The last 24 hours of each headline number, for the sparklines on the cards. */
const trends = ref<Record<'messages' | 'llmTokens' | 'flows', number[]>>({ messages: [], llmTokens: [], flows: [] })
const showRuntime = ref(false)

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

const sum = (series?: StatsSeries) => series?.points.map((point) => Object.values(point.values).reduce((total, value) => total + value, 0)) ?? []

async function refreshTrends() {
  const metrics = ['messages', 'llmTokens', 'flows'] as const
  const results = await Promise.all(metrics.map((metric) => call<StatsSeries>('stats.series', { metric, hours: 24 }).catch(() => undefined)))
  trends.value = { messages: sum(results[0]), llmTokens: sum(results[1]), flows: sum(results[2]) }
}

async function refreshRanking() {
  ranking.value = await call<StatsTopRow[]>('stats.top', { dimension: dimension.value, days: days.value, limit: 8 }).catch(() => [])
}

async function refreshShortcuts() {
  const [flowList, logs] = await Promise.all([
    call<FlowSummary[]>('flows.list').catch(() => []),
    call<LogLine[]>('logs.recent', { limit: 300 }).catch(() => []),
  ])
  allFlows.value = flowList
  errors.value = logs.filter((line) => line.type === 'error' || line.type === 'warn').slice(-4).reverse()
}

onMounted(async () => {
  agent.refreshSessions().catch(() => {})
  await Promise.all([refreshOverview(), refreshActivity(), refreshTrends(), refreshRanking(), refreshShortcuts()])
  samples.value = await call<PerfSample[]>('stats.performance').catch(() => [])
})

watch(range, () => Promise.all([refreshActivity(), refreshRanking()]))
watch(dimension, refreshRanking)

// Counts change with every message; refresh them now and then rather than on each event.
const timer = setInterval(() => {
  refreshOverview()
  refreshActivity()
  refreshTrends()
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

// ---- needs attention ----
// Only what someone should act on: a bot that cannot connect, a flow with errors, a provider
// that fails its test. Everything healthy stays out of this list.

interface Attention { key: string, level: 'bad' | 'warn', icon: Component, title: string, detail?: string, to: string }

const attention = computed<Attention[]>(() => {
  const items: Attention[] = []
  for (const bot of data.bots) {
    if (!bot.enabled) continue
    if (bot.status === 'error') items.push({ key: `bot-${bot.id}`, level: 'bad', icon: ChatbubblesOutline, title: t('overview.botProblem', { name: bot.name }), detail: bot.error, to: `/bots/${bot.id}/connection` })
    else if (bot.status !== 'online') items.push({ key: `bot-${bot.id}`, level: 'warn', icon: ChatbubblesOutline, title: t('overview.botWaiting', { name: bot.name }), detail: t('overview.botWaitingHint'), to: `/bots/${bot.id}/connection` })
  }
  for (const flow of allFlows.value) {
    if (flow.enabled && flow.errors) items.push({ key: `flow-${flow.id}`, level: 'bad', icon: GitNetworkOutline, title: t('overview.flowProblem', { name: flow.name }), detail: t('overview.flowErrors', { n: flow.errors }), to: `/flows/${flow.id}` })
  }
  for (const provider of data.providers) {
    if (provider.lastTest && !provider.lastTest.ok) items.push({ key: `provider-${provider.id}`, level: 'bad', icon: KeyOutline, title: t('overview.providerProblem', { name: provider.name }), detail: provider.lastTest.error, to: `/providers?highlight=${provider.id}` })
  }
  if (data.loadedProviders && !data.providers.length) items.push({ key: 'no-provider', level: 'warn', icon: KeyOutline, title: t('overview.noProvider'), detail: t('overview.noProviderHint'), to: '/providers' })
  return items.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1))
})

// ---- headline numbers ----

/** A sparkline path in a 200×30 box, scaled to the largest value. */
function sparkPath(values: number[]) {
  if (values.length < 2) return ''
  const max = Math.max(1, ...values)
  const step = 200 / (values.length - 1)
  return values.map((value, index) => `${index ? 'L' : 'M'}${(index * step).toFixed(1)},${(28 - (value / max) * 24).toFixed(1)}`).join(' ')
}

const cards = computed(() => {
  const value = overview.value
  if (!value) return []
  const problems = data.bots.filter((bot) => bot.enabled && bot.status === 'error').length
  return [
    {
      key: 'bots',
      icon: ChatbubblesOutline,
      label: t('overview.botsOnline'),
      value: number(value.bots.online),
      total: value.bots.total,
      hint: problems ? t('overview.botsProblem', { n: problems }) : t('overview.botsAll', { n: value.bots.total }),
      danger: problems > 0,
      to: '/bots',
      spark: '',
    },
    {
      key: 'messages',
      icon: SparklesOutline,
      label: t('overview.messagesToday'),
      value: number(value.today.received + value.today.sent),
      hint: t('overview.receivedSentN', { r: number(value.today.received), s: number(value.today.sent) }),
      spark: sparkPath(trends.value.messages),
    },
    {
      key: 'tokens',
      icon: FlashOutline,
      label: t('overview.tokensToday'),
      value: number(value.today.llmTokens),
      hint: t('overview.llmCalls', { n: value.today.llmCalls }),
      spark: sparkPath(trends.value.llmTokens),
    },
    {
      key: 'flows',
      icon: GitNetworkOutline,
      label: t('overview.flowRunsToday'),
      value: number(value.today.flowRuns),
      hint: value.today.flowErrors ? t('overview.failedRuns', { n: value.today.flowErrors }) : t('overview.flowsEnabled', { n: value.flows.enabled, total: value.flows.total }),
      danger: value.today.flowErrors > 0,
      to: '/flows',
      spark: sparkPath(trends.value.flows),
    },
  ]
})

// ---- messages chart ----

const axisTime = (time: number, granularity: 'hour' | 'day') => {
  const date = new Date(time)
  return granularity === 'day'
    ? `${date.getMonth() + 1}/${date.getDate()}`
    : `${String(date.getHours()).padStart(2, '0')}:00`
}

const ink = computed(() => (isDark.value ? palettes.dark : palettes.light))
const axis = computed(() => ({
  axisLine: { lineStyle: { color: ink.value.line } },
  axisTick: { show: false },
  axisLabel: { color: ink.value.fg3 },
  splitLine: { lineStyle: { color: ink.value.line, type: 'dashed' as const } },
}))
const tooltip = computed(() => ({
  trigger: 'axis' as const,
  backgroundColor: ink.value.s1,
  borderColor: ink.value.line,
  textStyle: { color: ink.value.fg },
}))

/** Messages per hour (or day), stacked by bot. Bots past the fifth fold into "other". */
const activityOption = computed<ChartOption>(() => {
  const value = activity.value
  const colors = isDark.value ? chartColors.dark : chartColors.light
  const series = value?.series ?? []
  const shown = series.slice(0, colors.length - (series.length > colors.length ? 1 : 0))
  const rest = series.slice(shown.length)
  const groups = [...shown.map((item) => ({ name: item.name, keys: [item.key] })), ...(rest.length ? [{ name: t('overview.otherBots'), keys: rest.map((item) => item.key) }] : [])]
  return {
    color: colors,
    grid: { left: 36, right: 8, top: groups.length > 1 ? 32 : 12, bottom: 24 },
    tooltip: { ...tooltip.value, axisPointer: { type: 'shadow' } },
    legend: groups.length > 1 ? { top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: ink.value.fg2 } } : undefined,
    xAxis: { type: 'category', data: value?.points.map((point) => axisTime(point.t, value.granularity)) ?? [], ...axis.value, splitLine: { show: false } },
    yAxis: { type: 'value', minInterval: 1, ...axis.value, axisLine: { show: false } },
    series: groups.map((group, index) => ({
      name: group.name,
      type: 'bar',
      stack: 'messages',
      barMaxWidth: 18,
      // A thin gap of card colour between stacked segments; only the top segment is rounded.
      itemStyle: { borderColor: ink.value.s1, borderWidth: 1, borderRadius: index === groups.length - 1 ? [4, 4, 0, 0] : 0 },
      emphasis: { focus: 'series' },
      data: value!.points.map((point) => group.keys.reduce((total, key) => total + (point.values[key] ?? 0), 0)),
    })),
  }
})

const hasActivity = computed(() => !!activity.value?.points.some((point) => Object.values(point.values).some((value) => value > 0)))

// ---- runtime ----
// CPU and memory are different units, so they get a chart each instead of sharing two y-axes.

const perfTime = (sample: PerfSample) => new Date(sample.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function perfOption(name: string, values: number[], color: string): ChartOption {
  return {
    color: [color],
    grid: { left: 40, right: 8, top: 12, bottom: 22 },
    tooltip: tooltip.value,
    xAxis: { type: 'category', boundaryGap: false, data: samples.value.map(perfTime), ...axis.value, splitLine: { show: false } },
    yAxis: { type: 'value', min: 0, ...axis.value, axisLine: { show: false } },
    series: [{ name, type: 'line', showSymbol: false, lineStyle: { width: 2 }, areaStyle: { opacity: 0.08 }, data: values }],
  }
}

const cpuOption = computed(() => perfOption('CPU %', samples.value.map((sample) => sample.cpu), (isDark.value ? chartColors.dark : chartColors.light)[0]))
const memoryOption = computed(() => perfOption('RSS MB', samples.value.map((sample) => Math.round(sample.rss / 1048576)), (isDark.value ? chartColors.dark : chartColors.light)[1]))

const runtimeSummary = computed(() => {
  const value = overview.value
  if (!value) return ''
  const parts = [t('overview.uptimeShort', { time: duration(value.uptime) })]
  if (value.sample) parts.unshift(`CPU ${value.sample.cpu.toFixed(1)}%`, `${t('overview.memoryShort')} ${mb(value.sample.rss)}`)
  return parts.join(' · ')
})

// ---- ranking ----

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

const recentFlows = computed(() => [...allFlows.value].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4))

function openSession(id: string) {
  agent.open = true
  agent.load(id).catch(() => {})
}
</script>

<template>
  <div class="page">
    <PageHeader :title="t('nav.overview')" :lead="t('overview.lead')" />

    <p v-if="unavailable" class="notice">{{ t('overview.unavailable') }}</p>

    <section v-if="attention.length" class="attention" data-agent-target="overview.attention">
      <header class="attention-head">
        <NIcon :size="16" class="attention-icon"><AlertCircleOutline /></NIcon>
        {{ t('overview.attention') }}
        <span class="attention-count">{{ attention.length }}</span>
      </header>
      <RouterLink v-for="item in attention" :key="item.key" :to="item.to" class="attention-row">
        <span class="stripe" :class="item.level" />
        <NIcon :size="16" class="attention-kind"><component :is="item.icon" /></NIcon>
        <span class="attention-text">
          <span class="attention-title">{{ item.title }}</span>
          <span v-if="item.detail" class="attention-detail" :title="item.detail">{{ item.detail }}</span>
        </span>
        <span class="attention-go">{{ t('overview.handle') }}<NIcon :size="14"><ChevronForwardOutline /></NIcon></span>
      </RouterLink>
    </section>

    <div v-if="cards.length" class="kpis">
      <component
        :is="card.to ? 'RouterLink' : 'div'"
        v-for="card in cards"
        :key="card.key"
        :to="card.to"
        class="kpi"
        :class="{ link: !!card.to }"
        :data-agent-target="`overview.${card.key}`"
      >
        <span class="kpi-label"><NIcon :size="15"><component :is="card.icon" /></NIcon>{{ card.label }}</span>
        <span class="kpi-value">{{ card.value }}<small v-if="card.total !== undefined">/ {{ card.total }}</small></span>
        <span class="kpi-hint" :class="{ danger: card.danger }">{{ card.hint }}</span>
        <svg v-if="card.spark" class="spark" viewBox="0 0 200 30" preserveAspectRatio="none" aria-hidden="true">
          <path :d="`${card.spark} L200,30 L0,30 Z`" class="spark-fill" />
          <path :d="card.spark" class="spark-line" />
        </svg>
        <span v-else class="spark" />
      </component>
    </div>

    <div class="grid-2">
      <section class="panel" data-agent-target="overview.activity">
        <header class="panel-head">
          <h2>{{ t('overview.activity') }}</h2>
          <NRadioGroup v-model:value="range" size="small">
            <NRadioButton value="24h">{{ t('overview.last24h') }}</NRadioButton>
            <NRadioButton value="7d">{{ t('overview.last7d') }}</NRadioButton>
          </NRadioGroup>
        </header>
        <EChart v-if="hasActivity" :option="activityOption" :height="240" />
        <NEmpty v-else :description="t('overview.noMessages')" class="empty" />
      </section>

      <section class="panel" data-agent-target="overview.ranking">
        <header class="panel-head">
          <h2>{{ t('overview.ranking') }}</h2>
          <NSelect v-model:value="dimension" :options="dimensions" size="small" class="rank-select" />
        </header>
        <ol v-if="ranking.length" class="ranks">
          <li v-for="(row, index) in ranking" :key="row.key" class="rank">
            <span class="rank-no">{{ index + 1 }}</span>
            <span class="rank-name" :title="row.id && row.id !== row.name ? row.id : undefined">{{ row.name }}</span>
            <span class="rank-count">{{ number(row.count) }}</span>
            <span class="rank-bar"><span :style="{ width: `${(row.count / maxCount) * 100}%` }" /></span>
            <span v-if="rankDetail(row)" class="rank-detail">{{ rankDetail(row) }}</span>
          </li>
        </ol>
        <NEmpty v-else :description="t('overview.noData')" class="empty" />
      </section>
    </div>

    <div class="grid-3">
      <section class="panel compact">
        <h2 class="list-title">{{ t('overview.recentChats') }}</h2>
        <button v-for="session in agent.sessions.slice(0, 4)" :key="session.id" type="button" class="shortcut hover-row" @click="openSession(session.id)">
          <span class="shortcut-name">{{ session.title || t('overview.untitled') }}</span>
          <span class="shortcut-meta">{{ formatTime(session.updatedAt) }}</span>
        </button>
        <p v-if="!agent.sessions.length" class="none">{{ t('overview.noChats') }}</p>
      </section>
      <section class="panel compact">
        <h2 class="list-title">{{ t('overview.recentFlows') }}</h2>
        <button v-for="flow in recentFlows" :key="flow.id" type="button" class="shortcut hover-row" @click="router.push(`/flows/${flow.id}`)">
          <span class="shortcut-name">{{ flow.name }}</span>
          <span class="shortcut-meta" :class="{ danger: flow.errors }">{{ flow.errors ? t('overview.flowErrors', { n: flow.errors }) : formatTime(flow.updatedAt) }}</span>
        </button>
        <p v-if="!recentFlows.length" class="none">{{ t('overview.noFlows') }}</p>
      </section>
      <section class="panel compact">
        <h2 class="list-title">{{ t('overview.recentErrors') }}</h2>
        <button v-for="line in errors" :key="line.sn" type="button" class="shortcut hover-row" @click="router.push('/logs')">
          <span class="shortcut-name" :class="line.type === 'error' ? 'danger' : 'warn'">{{ line.text }}</span>
          <span class="shortcut-meta">{{ formatTime(line.ts) }}</span>
        </button>
        <p v-if="!errors.length" class="none">{{ t('overview.noErrors') }}</p>
      </section>
    </div>

    <section v-if="overview" class="panel runtime" data-agent-target="overview.system">
      <button type="button" class="runtime-head" :aria-expanded="showRuntime" @click="showRuntime = !showRuntime">
        <h2>{{ t('overview.runtime') }}</h2>
        <span class="runtime-summary">{{ runtimeSummary }}</span>
        <NIcon :size="16" class="chevron" :class="{ open: showRuntime }"><ChevronDownOutline /></NIcon>
      </button>
      <div v-if="showRuntime" class="runtime-body">
        <dl class="facts">
          <div><dt>Mushin.js</dt><dd>{{ overview.versions.mushin ?? '—' }}</dd></div>
          <div><dt>Node.js</dt><dd>{{ overview.versions.node }}</dd></div>
          <div><dt>Cordis</dt><dd>{{ overview.versions.cordis ?? '—' }}</dd></div>
          <div><dt>{{ t('overview.platform') }}</dt><dd>{{ overview.platform }}</dd></div>
          <div><dt>{{ t('overview.uptime') }}</dt><dd>{{ duration(overview.uptime) }}</dd></div>
          <div><dt>{{ t('overview.dataSize') }}</dt><dd>{{ mb(overview.dataBytes) }}</dd></div>
          <div v-if="overview.sample"><dt>{{ t('overview.loopDelayShort') }}</dt><dd>{{ overview.sample.loopMean }} / {{ overview.sample.loopMax }} ms</dd></div>
          <div><dt>{{ t('overview.appPlugins') }}</dt><dd>{{ overview.appPlugins.enabled }} / {{ overview.appPlugins.total }}</dd></div>
          <div><dt>{{ t('overview.commands') }}</dt><dd>{{ overview.commands }}</dd></div>
        </dl>
        <div v-if="samples.length" class="perf">
          <div>
            <h3>{{ t('overview.cpuChart') }}</h3>
            <EChart :option="cpuOption" :height="160" />
          </div>
          <div>
            <h3>{{ t('overview.memoryChart') }}</h3>
            <EChart :option="memoryOption" :height="160" />
          </div>
        </div>
        <p v-else class="none">{{ t('overview.sampling') }}</p>
        <details class="plugins">
          <summary>{{ t('overview.pluginVersions', { n: overview.versions.plugins.length }) }}</summary>
          <div v-for="plugin in overview.versions.plugins" :key="plugin.package" class="plugin">
            <span class="mono">{{ plugin.package }}</span>
            <span class="plugin-version">{{ plugin.version ?? '—' }}<template v-if="!plugin.enabled"> · {{ t('overview.off') }}</template></span>
          </div>
        </details>
        <RouterLink to="/plugins">
          <NButton size="small" quaternary>{{ t('nav.plugins') }}<template #icon><NIcon><ChevronForwardOutline /></NIcon></template></NButton>
        </RouterLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.notice {
  margin: 0 0 16px;
  color: var(--fg2);
}

/* ---- needs attention ---- */

.attention {
  margin-bottom: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
  overflow: hidden;
}

.attention-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
  font-weight: 600;
}

.attention-icon {
  color: var(--warn);
}

.attention-count {
  padding: 0 8px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
  line-height: 20px;
  color: var(--warn);
  background: var(--warn-soft);
}

.attention-row {
  display: grid;
  grid-template-columns: 4px 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px 18px 10px 0;
  color: inherit;
}

.attention-row + .attention-row {
  border-top: 1px solid var(--line);
}

.attention-row:hover {
  background: var(--s2);
  text-decoration: none;
}

.stripe {
  align-self: stretch;
  border-radius: 0 3px 3px 0;
}

.stripe.bad { background: var(--bad); }
.stripe.warn { background: var(--warn); }

.attention-kind {
  color: var(--fg2);
}

.attention-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.attention-title {
  font-weight: 500;
}

.attention-detail {
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--fg2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attention-go {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 13px;
  color: var(--primary);
}

/* ---- headline numbers ---- */

.kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.kpi {
  display: grid;
  grid-template-rows: auto auto auto 30px;
  gap: 2px;
  min-width: 0;
  padding: 14px 16px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
  color: inherit;
}

.kpi.link:hover {
  border-color: var(--primary);
  text-decoration: none;
}

.kpi-label {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: var(--fg2);
}

.kpi-value {
  margin-top: 6px;
  font-size: 26px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.kpi-value small {
  margin-left: 4px;
  font-size: 14px;
  font-weight: 500;
  color: var(--fg3);
}

.kpi-hint {
  font-size: 12px;
  color: var(--fg3);
}

.danger {
  color: var(--bad) !important;
}

.warn {
  color: var(--warn);
}

.spark {
  width: 100%;
  height: 30px;
  margin-top: 4px;
}

.spark-fill {
  fill: var(--primary);
  opacity: 0.1;
}

.spark-line {
  fill: none;
  stroke: var(--primary);
  stroke-width: 1.6;
  vector-effect: non-scaling-stroke;
}

/* ---- panels ---- */

.grid-2 {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}

.grid-3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.panel {
  min-width: 0;
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
}

.panel.compact {
  padding: 14px 10px 10px;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.panel-head h2,
.runtime-head h2 {
  flex: 1;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.list-title {
  margin: 0 8px 8px;
  font-size: 14px;
  font-weight: 600;
}

.empty {
  padding: 48px 0;
}

.none {
  margin: 0;
  padding: 6px 8px;
  font-size: 12.5px;
  color: var(--fg3);
}

.rank-select {
  width: 104px;
}

.ranks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rank {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  gap: 4px 10px;
  align-items: center;
  font-size: 13px;
}

.rank-no {
  font-size: 12px;
  color: var(--fg3);
  font-variant-numeric: tabular-nums;
}

.rank-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rank-count {
  color: var(--fg2);
  font-variant-numeric: tabular-nums;
}

.rank-bar {
  grid-column: 2 / -1;
  height: 4px;
  border-radius: 2px;
  background: var(--s2);
  overflow: hidden;
}

.rank-bar span {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--primary);
}

.rank-detail {
  grid-column: 2 / -1;
  font-size: 12px;
  color: var(--fg3);
}

.shortcut {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.shortcut-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shortcut-meta {
  flex: none;
  font-size: 12px;
  color: var(--fg3);
}

/* ---- runtime ---- */

.runtime {
  padding: 0;
}

.runtime-head {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 18px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.runtime-head h2 {
  flex: none;
}

.runtime-summary {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--fg3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.runtime-head:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
  border-radius: var(--radius);
}

.chevron {
  color: var(--fg3);
  transition: transform 0.2s;
}

.chevron.open {
  transform: rotate(180deg);
}

.runtime-body {
  padding: 0 18px 16px;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 28px;
  margin: 0 0 16px;
  font-size: 13px;
}

.facts div {
  display: flex;
  gap: 6px;
}

.facts dt {
  color: var(--fg2);
}

.facts dd {
  margin: 0;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.perf {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.perf h3 {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 500;
  color: var(--fg2);
}

.plugins {
  margin-top: 12px;
  font-size: 13px;
}

.plugins summary {
  cursor: pointer;
  color: var(--fg2);
}

.plugin {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
}

.plugin .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-version {
  flex: none;
  color: var(--fg3);
}

@media (max-width: 1100px) {
  .kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .grid-2 {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 760px) {
  .grid-3,
  .perf {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
