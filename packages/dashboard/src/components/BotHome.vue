<script setup lang="ts">
/**
 * A bot at a glance: one tile per part of the bot (connection, messages, plugins, commands,
 * personas, permissions, runs, flows), each with its summary and a click through to its page.
 * Below, the chats it is busiest in and the flows that run on it.
 */
import { Empty } from '@mushinjs/ui'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../api'
import { useDataStore } from '../stores/data'
import type { Bot, BotPersonaSettings, BotPluginInfo, FlowSummary, Persona, StatsSeries, StatsTopRow } from '../types'
import { localize } from '../utils'
import AdapterIcon from './AdapterIcon.vue'
import BotActivity from './runs/BotActivity.vue'

const props = defineProps<{ bot: Bot }>()
const { t, locale } = useI18n()
const data = useDataStore()

const series = ref<number[]>()
const chats = ref<StatsTopRow[]>()
const flows = ref<FlowSummary[]>([])
const plugins = ref<BotPluginInfo[]>([])
const commands = ref<number>()
const roles = ref<{ masters: string[]; admins: string[] }>()
const persona = ref<{ name?: string; count: number }>()

async function load() {
  const id = props.bot.id
  const [messages, top, list, pluginList, commandList, permissions, personaSettings, personaList] = await Promise.all([
    call<StatsSeries>('stats.series', { metric: 'messages', hours: 24 }).catch(() => undefined),
    call<StatsTopRow[]>('stats.top', { dimension: 'channels', days: 7, limit: 50 }).catch(() => undefined),
    call<FlowSummary[]>('flows.list').catch(() => [] as FlowSummary[]),
    call<BotPluginInfo[]>('bots.plugins.list', { id }).catch(() => [] as BotPluginInfo[]),
    call<{ commands: unknown[] }>('commands.list', { bot: id }).catch(() => undefined),
    call<{ masters: string[]; admins: string[] }>('permissions.get', { bot: id }).catch(() => undefined),
    call<BotPersonaSettings>('personas.botSettings', { bot: id }).catch(() => undefined),
    call<Persona[]>('personas.list').catch(() => undefined),
  ])
  series.value = messages?.points.map((point) => point.values[id] ?? 0)
  chats.value = top?.filter((row) => row.botId === id).slice(0, 5)
  flows.value = list.filter((flow) => flow.bots.includes(id))
  plugins.value = pluginList
  commands.value = commandList?.commands.length
  roles.value = permissions
  persona.value = personaSettings && {
    name: personaList?.find((item) => item.id === personaSettings.default)?.name,
    count: personaSettings.personas.length,
  }
}

onMounted(load)
watch(() => props.bot.id, load)

const adapter = computed(() => data.adapters.find((item) => item.id === props.bot.adapter.type))
const today = computed(() => series.value?.reduce((sum, value) => sum + value, 0))
const enabledPlugins = computed(() => plugins.value.filter((plugin) => plugin.enabled))
const maxChat = computed(() => Math.max(1, ...(chats.value ?? []).map((row) => row.count)))

/** A 24-hour sparkline as an SVG path, scaled to the busiest hour. */
const spark = computed(() => {
  const values = series.value
  if (!values?.length) return ''
  const max = Math.max(1, ...values)
  const step = 200 / Math.max(1, values.length - 1)
  return values.map((value, index) => `${index ? 'L' : 'M'}${(index * step).toFixed(1)},${(30 - 3 - (value / max) * 24).toFixed(1)}`).join(' ')
})

const state = computed(() => {
  const bot = props.bot
  if (!bot.enabled) return { cls: 'idle', text: t('bots.state.stopped') }
  if (bot.status === 'error') return { cls: 'bad', text: t('bots.state.problem') }
  const cls = bot.status === 'online' ? 'ok' : bot.status === 'connecting' ? 'warn' : 'idle'
  return { cls, text: t(`bots.state.${bot.status}`) }
})

const base = computed(() => `/bots/${props.bot.id}`)
</script>

<template>
  <div class="home">
    <div class="tiles">
      <RouterLink :to="`${base}/connection`" class="tile">
        <span class="tile-head"><span class="i-lucide-link text-[15px]" />{{ t('bot.connection') }}</span>
        <span class="tile-value conn">
          <AdapterIcon :adapter="adapter" :size="18" />
          <span class="pill" :class="state.cls"><span class="dot" />{{ state.text }}</span>
        </span>
        <span class="tile-hint" :class="{ bad: bot.status === 'error' }" :title="bot.error">
          {{ bot.status === 'error' ? bot.error : localize(adapter?.displayName, locale) || bot.adapter.type }}
        </span>
      </RouterLink>

      <RouterLink :to="`${base}/live`" class="tile">
        <span class="tile-head"><span class="i-lucide-message-circle-more text-[15px]" />{{ t('botHome.messages') }}</span>
        <span class="tile-value">{{ today ?? '—' }}</span>
        <svg v-if="spark" class="spark" viewBox="0 0 200 30" preserveAspectRatio="none" aria-hidden="true">
          <path :d="`${spark} L200,30 L0,30 Z`" class="spark-fill" />
          <path :d="spark" class="spark-line" />
        </svg>
        <span v-else class="tile-hint">{{ t('botHome.openLive') }}</span>
      </RouterLink>

      <RouterLink :to="`${base}/plugins`" class="tile">
        <span class="tile-head"><span class="i-lucide-puzzle text-[15px]" />{{ t('bot.plugins') }}</span>
        <span class="tile-value">{{ enabledPlugins.length }}<small>/ {{ plugins.length }}</small></span>
        <span class="chips">
          <span v-for="plugin in enabledPlugins.slice(0, 3)" :key="plugin.package" class="chip">{{ localize(plugin.manifest.displayName, locale) || plugin.package }}</span>
          <span v-if="enabledPlugins.length > 3" class="chip more">+{{ enabledPlugins.length - 3 }}</span>
        </span>
      </RouterLink>

      <RouterLink :to="`${base}/commands`" class="tile">
        <span class="tile-head"><span class="i-lucide-code text-[15px]" />{{ t('bot.commands') }}</span>
        <span class="tile-value">{{ commands ?? '—' }}</span>
        <span class="tile-hint">{{ t('botHome.commandsHint') }}</span>
      </RouterLink>

      <RouterLink :to="`${base}/personas`" class="tile">
        <span class="tile-head"><span class="i-lucide-circle-user text-[15px]" />{{ t('bot.personas') }}</span>
        <span class="tile-value text">{{ persona ? persona.name || t('botHome.noPersona') : '—' }}</span>
        <span class="tile-hint">{{ persona ? t('botHome.personaCount', { n: persona.count }) : t('botHome.pluginOff') }}</span>
      </RouterLink>

      <RouterLink :to="`${base}/permissions`" class="tile">
        <span class="tile-head"><span class="i-lucide-shield-check text-[15px]" />{{ t('bot.permissions') }}</span>
        <span class="tile-value text">{{ roles ? t('botHome.roles', { masters: roles.masters.length, admins: roles.admins.length }) : '—' }}</span>
        <span class="tile-hint">{{ roles ? (roles.masters.length ? roles.masters.slice(0, 3).join('、') : t('botHome.noMaster')) : t('botHome.pluginOff') }}</span>
      </RouterLink>

      <RouterLink :to="`${base}/runs`" class="tile">
        <span class="tile-head"><span class="i-lucide-list text-[15px]" />{{ t('runs.tab') }}</span>
        <span class="tile-activity"><BotActivity :bot-id="bot.id" /></span>
      </RouterLink>

      <RouterLink to="/flows" class="tile">
        <span class="tile-head"><span class="i-lucide-network text-[15px]" />{{ t('nav.flows') }}</span>
        <span class="tile-value">{{ flows.length }}</span>
        <span class="tile-hint">{{ t('botHome.flowsHint', { n: flows.filter((flow) => flow.enabled).length }) }}</span>
      </RouterLink>
    </div>

    <div class="grid">
      <section class="panel">
        <header class="panel-head">
          <h2>{{ t('botHome.busiest') }}</h2>
          <span class="faint">{{ t('botHome.last7d') }}</span>
        </header>
        <ol v-if="chats?.length" class="ranks">
          <li v-for="row in chats" :key="row.key">
            <RouterLink :to="`${base}/live`" class="rank hover-row">
              <span class="rank-name" :title="row.id">{{ row.name }}</span>
              <span class="rank-count">{{ row.count }}</span>
              <span class="rank-bar"><span :style="{ width: `${(row.count / maxChat) * 100}%` }" /></span>
            </RouterLink>
          </li>
        </ol>
        <p v-else class="faint empty">{{ chats ? t('botHome.noMessages') : t('botHome.noStats') }}</p>
      </section>

      <section class="panel">
        <header class="panel-head">
          <h2>{{ t('botHome.flowsOnBot') }}</h2>
          <RouterLink to="/flows" class="more">{{ t('nav.flows') }}<span class="i-lucide-chevron-right text-[14px]" /></RouterLink>
        </header>
        <ul v-if="flows.length" class="flows">
          <li v-for="flow in flows" :key="flow.id">
            <RouterLink :to="`/flows/${flow.id}`" class="flow hover-row" :class="{ off: !flow.enabled }">
              <span class="i-lucide-network flow-icon text-[16px]" />
              <span class="flow-name">{{ flow.name }}</span>
              <span class="flow-triggers">{{ flow.triggers.filter((item) => !item.skip).map((item) => item.summary).filter(Boolean).join('、') }}</span>
              <span v-if="!flow.enabled" class="faint">{{ t('flows.disabledTag') }}</span>
              <span v-else-if="flow.errors" class="bad">{{ t('flows.errorCount', flow.errors) }}</span>
            </RouterLink>
          </li>
        </ul>
        <Empty v-else :description="t('botHome.noFlows')" size="small" class="empty" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}

.tile {
  display: grid;
  grid-template-rows: auto auto 1fr;
  gap: 6px;
  min-width: 0;
  min-height: 112px;
  padding: 14px 16px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
  color: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.tile:hover {
  border-color: var(--primary);
  box-shadow: var(--shadow);
  text-decoration: none;
}

.tile:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.tile-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--fg2);
}

.tile-value {
  font-size: 22px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tile-value.text {
  font-size: 15px;
  line-height: 30px;
}

.tile-value small {
  margin-left: 4px;
  font-size: 13px;
  font-weight: 500;
  color: var(--fg3);
}

.tile-value.conn {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
}

.tile-hint {
  align-self: end;
  overflow: hidden;
  font-size: 12px;
  color: var(--fg3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-hint.bad {
  color: var(--bad);
}

.tile-activity {
  align-self: end;
  min-width: 0;
  font-size: 12.5px;
  color: var(--fg2);
}

.chips {
  display: flex;
  align-self: end;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}

.chip {
  flex: none;
  max-width: 100%;
  height: 20px;
  padding: 0 7px;
  overflow: hidden;
  border-radius: 10px;
  background: var(--s2);
  font-size: 11.5px;
  line-height: 20px;
  color: var(--fg2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip.more {
  color: var(--fg3);
}

.spark {
  align-self: end;
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

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 9px;
  border-radius: 11px;
  font-size: 12px;
  font-weight: 500;
}

.pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.pill.ok { color: var(--ok); background: var(--ok-soft); }
.pill.warn { color: var(--warn); background: var(--warn-soft); }
.pill.bad { color: var(--bad); background: var(--bad-soft); }
.pill.idle { color: var(--fg2); background: var(--s2); }

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.panel {
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.panel-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.more {
  display: inline-flex;
  align-items: center;
  font-size: 12.5px;
}

.faint {
  font-size: 12.5px;
  color: var(--fg3);
}

.bad {
  color: var(--bad);
}

.empty {
  margin: 12px 0;
}

.ranks,
.flows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rank {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 8px;
  padding: 6px 8px;
  border-radius: 6px;
  color: inherit;
  font-size: 13px;
}

.rank:hover,
.flow:hover {
  text-decoration: none;
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
  grid-column: 1 / -1;
  height: 4px;
  border-radius: 2px;
  background: var(--s2);
}

.rank-bar span {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--primary);
  opacity: 0.6;
}

.flow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 6px;
  color: inherit;
  font-size: 13px;
}

.flow.off {
  opacity: 0.6;
}

.flow-icon {
  flex: none;
  color: var(--fg3);
}

.flow-name {
  flex: none;
  font-weight: 500;
}

.flow-triggers {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--fg3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 1100px) {
  .tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
