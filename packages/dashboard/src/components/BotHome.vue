<script setup lang="ts">
/**
 * A bot at a glance: what it handled today, how it connects, where it is busiest and which flows
 * run on it. Each block links to the page that has the detail.
 */
import { ArrowBackOutline, ArrowForwardOutline, ChevronForwardOutline, GitNetworkOutline } from '@vicons/ionicons5'
import { NButton, NEmpty, NIcon } from 'naive-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../api'
import type { Bot, FlowSummary, StatsSeries, StatsTopRow } from '../types'
import BotActivity from './runs/BotActivity.vue'

const props = defineProps<{ bot: Bot }>()
const { t } = useI18n()

const series = ref<number[]>()
const chats = ref<StatsTopRow[]>()
const flows = ref<FlowSummary[]>([])

async function load() {
  const id = props.bot.id
  const [messages, top, list] = await Promise.all([
    call<StatsSeries>('stats.series', { metric: 'messages', hours: 24 }).catch(() => undefined),
    call<StatsTopRow[]>('stats.top', { dimension: 'channels', days: 7, limit: 50 }).catch(() => undefined),
    call<FlowSummary[]>('flows.list').catch(() => [] as FlowSummary[]),
  ])
  series.value = messages?.points.map((point) => point.values[id] ?? 0)
  chats.value = top?.filter((row) => row.botId === id).slice(0, 5)
  flows.value = list.filter((flow) => flow.bots.includes(id))
}

onMounted(load)
watch(() => props.bot.id, load)

const today = computed(() => series.value?.reduce((sum, value) => sum + value, 0))
const plugins = computed(() => props.bot.plugins.filter((plugin) => plugin.enabled).length)
const maxChat = computed(() => Math.max(1, ...(chats.value ?? []).map((row) => row.count)))

/** A 24-hour sparkline as an SVG path, scaled to the busiest hour. */
const spark = computed(() => {
  const values = series.value
  if (!values?.length) return ''
  const max = Math.max(1, ...values)
  const step = 200 / Math.max(1, values.length - 1)
  return values.map((value, index) => `${index ? 'L' : 'M'}${(index * step).toFixed(1)},${(30 - 3 - (value / max) * 24).toFixed(1)}`).join(' ')
})

const connection = computed(() => {
  const info = props.bot.connection
  if (!info) return { mode: '', tag: props.bot.adapter.type, address: '' }
  const tag = t(`bots.mode.${info.mode}`) === `bots.mode.${info.mode}` ? info.mode : t(`bots.mode.${info.mode}`)
  return { mode: info.mode, tag, address: info.address ?? '' }
})
</script>

<template>
  <div class="home">
    <div class="stats">
      <RouterLink :to="`/bots/${bot.id}/live`" class="stat">
        <span class="label">{{ t('botHome.messages') }}</span>
        <span class="value">{{ today ?? '—' }}</span>
        <svg v-if="spark" class="spark" viewBox="0 0 200 30" preserveAspectRatio="none" aria-hidden="true">
          <path :d="`${spark} L200,30 L0,30 Z`" class="spark-fill" />
          <path :d="spark" class="spark-line" />
        </svg>
      </RouterLink>
      <RouterLink :to="`/bots/${bot.id}/plugins`" class="stat">
        <span class="label">{{ t('botHome.plugins') }}</span>
        <span class="value">{{ plugins }}<small>/ {{ bot.plugins.length }}</small></span>
        <span class="hint">{{ t('botHome.pluginsHint') }}</span>
      </RouterLink>
      <RouterLink to="/flows" class="stat">
        <span class="label">{{ t('botHome.flows') }}</span>
        <span class="value">{{ flows.length }}</span>
        <span class="hint">{{ t('botHome.flowsHint', { n: flows.filter((flow) => flow.enabled).length }) }}</span>
      </RouterLink>
    </div>

    <div class="grid">
      <section class="panel">
        <header class="panel-head">
          <h2>{{ t('bot.connection') }}</h2>
          <RouterLink :to="`/bots/${bot.id}/connection`" class="more">{{ t('botHome.edit') }}<NIcon :size="14"><ChevronForwardOutline /></NIcon></RouterLink>
        </header>
        <div class="conn">
          <NIcon :size="16" class="conn-icon">
            <ArrowBackOutline v-if="connection.mode === 'ws-reverse'" />
            <ArrowForwardOutline v-else />
          </NIcon>
          <span class="conn-mode">{{ connection.tag }}</span>
          <span class="mono conn-address" :title="connection.address">{{ connection.address }}</span>
        </div>
        <p v-if="bot.status === 'error'" class="conn-note bad">{{ bot.error }}</p>
        <p v-else-if="bot.status !== 'online'" class="conn-note">{{ bot.enabled ? t('botHome.notConnected') : t('bots.stoppedHint') }}</p>
        <RouterLink v-else :to="`/bots/${bot.id}/runs`" class="conn-note activity"><BotActivity :bot-id="bot.id" /></RouterLink>
        <RouterLink v-if="bot.status !== 'online' && bot.enabled" :to="`/bots/${bot.id}/connection`">
          <NButton size="small" type="primary" secondary>{{ t('botHome.setUp') }}</NButton>
        </RouterLink>
      </section>

      <section class="panel">
        <header class="panel-head">
          <h2>{{ t('botHome.busiest') }}</h2>
          <span class="faint">{{ t('botHome.last7d') }}</span>
        </header>
        <ol v-if="chats?.length" class="ranks">
          <li v-for="row in chats" :key="row.key" class="rank">
            <span class="rank-name" :title="row.id">{{ row.name }}</span>
            <span class="rank-count">{{ row.count }}</span>
            <span class="rank-bar"><span :style="{ width: `${(row.count / maxChat) * 100}%` }" /></span>
          </li>
        </ol>
        <p v-else class="faint empty">{{ chats ? t('botHome.noMessages') : t('botHome.noStats') }}</p>
      </section>

      <section class="panel wide">
        <header class="panel-head">
          <h2>{{ t('botHome.flowsOnBot') }}</h2>
          <RouterLink to="/flows" class="more">{{ t('nav.flows') }}<NIcon :size="14"><ChevronForwardOutline /></NIcon></RouterLink>
        </header>
        <ul v-if="flows.length" class="flows">
          <li v-for="flow in flows" :key="flow.id">
            <RouterLink :to="`/flows/${flow.id}`" class="flow hover-row" :class="{ off: !flow.enabled }">
              <NIcon :size="16" class="flow-icon"><GitNetworkOutline /></NIcon>
              <span class="flow-name">{{ flow.name }}</span>
              <span class="flow-triggers">{{ flow.triggers.filter((item) => !item.skip).map((item) => item.summary).filter(Boolean).join('、') }}</span>
              <span v-if="!flow.enabled" class="faint">{{ t('flows.disabledTag') }}</span>
              <span v-else-if="flow.errors" class="bad">{{ t('flows.errorCount', flow.errors) }}</span>
            </RouterLink>
          </li>
        </ul>
        <NEmpty v-else :description="t('botHome.noFlows')" size="small" class="empty" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.stat {
  display: grid;
  grid-template-rows: auto auto 30px;
  gap: 4px;
  padding: 14px 16px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
  color: inherit;
  min-width: 0;
}

.stat:hover {
  border-color: var(--primary);
  text-decoration: none;
}

.label {
  font-size: 13px;
  color: var(--fg2);
}

.value {
  font-size: 24px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.value small {
  margin-left: 4px;
  font-size: 13px;
  font-weight: 500;
  color: var(--fg3);
}

.hint {
  align-self: center;
  font-size: 12px;
  color: var(--fg3);
}

.spark {
  width: 100%;
  height: 30px;
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

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.panel {
  min-width: 0;
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
}

.panel.wide {
  grid-column: 1 / -1;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.panel-head h2 {
  flex: 1;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.more {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 13px;
}

.faint {
  color: var(--fg3);
  font-size: 12.5px;
}

.bad {
  color: var(--bad);
  font-size: 12.5px;
}

.empty {
  padding: 12px 0;
  margin: 0;
}

.conn {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--fg2);
}

.conn-icon,
.conn-mode {
  flex: none;
}

.conn-address {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
}

.conn-note {
  display: flex;
  margin: 10px 0 12px;
  font-size: 13px;
  color: var(--fg3);
}

.conn-note.bad {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.conn-note.activity {
  color: inherit;
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
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 10px;
  font-size: 13px;
}

.rank-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rank-count {
  font-variant-numeric: tabular-nums;
  color: var(--fg2);
}

.rank-bar {
  grid-column: 1 / -1;
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

.flows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.flow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  color: inherit;
  min-width: 0;
}

.flow:hover {
  text-decoration: none;
}

.flow.off {
  opacity: 0.6;
}

.flow-icon {
  flex: none;
  color: var(--fg2);
}

.flow-name {
  flex: none;
  font-weight: 500;
}

.flow-triggers {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--fg3);
}

@media (max-width: 760px) {
  .stats,
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
