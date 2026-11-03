<script setup lang="ts">
import { AddOutline, AlertCircleOutline, ArrowBackOutline, ChatbubblesOutline, ArrowForwardOutline, PlayOutline, SearchOutline, StopOutline, TimeOutline } from '@vicons/ionicons5'
import { NButton, NEmpty, NIcon, NInput, useMessage } from 'naive-ui'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { call } from '../api'
import BotEditor from '../components/BotEditor.vue'
import EmptyState from '../components/EmptyState.vue'
import PageHeader from '../components/PageHeader.vue'
import BotActivity from '../components/runs/BotActivity.vue'
import { avatarColor, initial } from '../botAvatar'
import { useDataStore } from '../stores/data'
import type { Bot } from '../types'

const { t } = useI18n()
const router = useRouter()
const data = useDataStore()
const message = useMessage()
const route = useRoute()
const showCreate = ref(false)
// /bots?new=1 (from search) opens the add dialog.
if (route.query.new) {
  showCreate.value = true
  router.replace({ query: { ...route.query, new: undefined } })
}
const busy = ref<string>()

onMounted(() => data.refreshBots().catch((error) => message.error(error.message)))

async function toggle(bot: Bot, enabled: boolean) {
  busy.value = bot.id
  try {
    await call(enabled ? 'bots.start' : 'bots.stop', { id: bot.id })
    await data.refreshBots()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    busy.value = undefined
  }
}

/** The connection mode as a short label, and where the bot connects. */
function connectionOf(bot: Bot) {
  const info = bot.connection
  if (!info) return { mode: '', tag: bot.adapter.type, address: '' }
  const tag = t(`bots.mode.${info.mode}`) === `bots.mode.${info.mode}` ? info.mode : t(`bots.mode.${info.mode}`)
  if (info.mode === 'ws-reverse') return { mode: info.mode, tag, address: t('bots.reverseTo', { path: info.address }) }
  if (info.mode === 'http') return { mode: info.mode, tag, address: t('bots.httpTo', { url: info.address, path: info.inbound }) }
  return { mode: info.mode, tag, address: t('bots.forwardTo', { url: info.address }) }
}

// ---- one status per card ----
// A stopped bot is "stopped", whatever its connection did last; a running one shows its connection.

type State = 'online' | 'connecting' | 'problem' | 'offline' | 'stopped'

function stateOf(bot: Bot): State {
  if (!bot.enabled) return 'stopped'
  if (bot.status === 'error') return 'problem'
  return bot.status
}

const stateClass: Record<State, string> = { online: 'ok', connecting: 'warn', problem: 'bad', offline: 'idle', stopped: 'idle' }
const stateLabel = (state: State) => t(`bots.state.${state}`)

// ---- search and filters ----

type Filter = 'all' | 'online' | 'problem' | 'stopped'
const query = ref('')
const filter = ref<Filter>('all')

const counts = computed(() => {
  const states = data.bots.map(stateOf)
  return {
    all: states.length,
    online: states.filter((state) => state === 'online').length,
    problem: states.filter((state) => state === 'problem').length,
    stopped: states.filter((state) => state === 'stopped').length,
  }
})

const filters = computed(() => ([
  { key: 'all', dot: '' },
  { key: 'online', dot: 'ok' },
  { key: 'problem', dot: 'bad' },
  { key: 'stopped', dot: 'idle' },
] as const).filter((item) => item.key === 'all' || counts.value[item.key] > 0 || filter.value === item.key))

const shown = computed(() => {
  const text = query.value.trim().toLowerCase()
  return data.bots.filter((bot) => {
    if (filter.value !== 'all' && stateOf(bot) !== filter.value) return false
    if (!text) return true
    return [bot.name, bot.selfName, bot.selfId, bot.connection?.address].some((value) => value?.toLowerCase().includes(text))
  })
})

const account = (bot: Bot) => (bot.selfName ? `${bot.selfName} · ${bot.selfId}` : bot.selfId ?? t('bots.notLoggedIn'))
const enabledPlugins = (bot: Bot) => bot.plugins.filter((plugin) => plugin.enabled).length
const open = (bot: Bot) => router.push(`/bots/${bot.id}`)
</script>

<template>
  <div class="page">
    <PageHeader :title="t('nav.bots')" :lead="t('bots.lead')">
      <NButton type="primary" data-agent-target="bots.add" @click="showCreate = true">
        <template #icon><NIcon><AddOutline /></NIcon></template>
        {{ t('bots.add') }}
      </NButton>
    </PageHeader>

    <div v-if="data.bots.length > 1" class="toolbar">
      <NInput v-model:value="query" clearable :placeholder="t('bots.search')" class="search">
        <template #prefix><NIcon><SearchOutline /></NIcon></template>
      </NInput>
      <div class="chips" role="radiogroup" :aria-label="t('bots.filterLabel')">
        <button
          v-for="item in filters"
          :key="item.key"
          type="button"
          role="radio"
          class="chip"
          :class="{ on: filter === item.key }"
          :aria-checked="filter === item.key"
          @click="filter = item.key"
        >
          <span v-if="item.dot" class="dot" :class="item.dot" />
          {{ t(`bots.filter.${item.key}`) }}
          <span class="count">{{ counts[item.key] }}</span>
        </button>
      </div>
    </div>

    <div v-if="data.bots.length" class="bot-grid">
      <article
        v-for="bot in shown"
        :key="bot.id"
        class="bot"
        :class="{ stopped: !bot.enabled }"
        tabindex="0"
        :aria-label="bot.name"
        @click="open(bot)"
        @keyup.enter.self="open(bot)"
      >
        <div class="bot-head">
          <div class="avatar" :style="{ background: avatarColor(bot.id) }" aria-hidden="true">
            {{ initial(bot.name) }}
            <span class="dot" :class="stateClass[stateOf(bot)]" />
          </div>
          <div class="bot-title">
            <strong class="name">{{ bot.name }}</strong>
            <span class="account">{{ account(bot) }}</span>
          </div>
          <span class="pill" :class="stateClass[stateOf(bot)]"><span class="dot" />{{ stateLabel(stateOf(bot)) }}</span>
        </div>

        <div class="bot-body">
          <div class="conn" :title="connectionOf(bot).address">
            <NIcon class="conn-icon" :size="15">
              <ArrowBackOutline v-if="connectionOf(bot).mode === 'ws-reverse'" />
              <ArrowForwardOutline v-else />
            </NIcon>
            <span class="mode">{{ connectionOf(bot).tag }}</span>
            <span class="mono address">{{ connectionOf(bot).address }}</span>
          </div>
          <div v-if="stateOf(bot) === 'problem'" class="note bad" :title="bot.error">
            <NIcon :size="15"><AlertCircleOutline /></NIcon>
            <span class="clamp">{{ bot.error || t('bots.state.problem') }}</span>
          </div>
          <RouterLink v-else-if="stateOf(bot) === 'online'" :to="`/bots/${bot.id}/runs`" class="note activity" @click.stop>
            <BotActivity :bot-id="bot.id" />
          </RouterLink>
          <div v-else class="note">
            <NIcon :size="15"><TimeOutline /></NIcon>
            <span>{{ stateOf(bot) === 'connecting' ? t('bots.connectingHint') : stateOf(bot) === 'stopped' ? t('bots.stoppedHint') : t('bots.offlineHint') }}</span>
          </div>
        </div>

        <div class="bot-foot" @click.stop>
          <span>{{ t('bots.pluginCount', enabledPlugins(bot)) }}</span>
          <NButton v-if="bot.enabled" size="small" quaternary :loading="busy === bot.id" @click="toggle(bot, false)">
            <template #icon><NIcon><StopOutline /></NIcon></template>
            {{ t('common.stop') }}
          </NButton>
          <NButton v-else size="small" secondary type="primary" :loading="busy === bot.id" @click="toggle(bot, true)">
            <template #icon><NIcon><PlayOutline /></NIcon></template>
            {{ t('common.start') }}
          </NButton>
        </div>
      </article>

      <button v-if="filter === 'all' && !query" type="button" class="add-card" @click="showCreate = true">
        <span class="plus"><NIcon :size="20"><AddOutline /></NIcon></span>
        <strong>{{ t('bots.add') }}</strong>
        <span class="hint">{{ t('bots.addHint') }}</span>
      </button>
    </div>

    <NEmpty v-if="data.bots.length && !shown.length" :description="t('bots.noMatch')" class="no-match" />

    <EmptyState v-else-if="!data.bots.length && data.loadedBots" :icon="ChatbubblesOutline" :title="t('bots.emptyTitle')" :hint="t('bots.emptyHint')">
      <NButton type="primary" @click="showCreate = true">{{ t('bots.add') }}</NButton>
    </EmptyState>

    <BotEditor v-model:show="showCreate" @created="(bot) => router.push(`/bots/${bot.id}`)" />
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin-bottom: 16px;
}

.search {
  width: 240px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 15px;
  background: var(--s1);
  color: var(--fg2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.chip:hover {
  color: var(--fg);
}

.chip.on {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
}

.chip:focus-visible,
.bot:focus-visible,
.add-card:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.count {
  font-size: 12px;
  color: var(--fg3);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--idle);
}

.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.bad { background: var(--bad); }

/* Cards are all the same height, so a long error does not push the grid around. */
.bot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

.bot {
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 196px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.bot:hover {
  border-color: var(--primary);
  box-shadow: var(--shadow);
}

.bot.stopped {
  background: color-mix(in srgb, var(--s1) 70%, var(--bg));
}

.bot-head {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 16px 16px 10px;
}

.avatar {
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #fff;
  font-size: 15px;
  font-weight: 650;
}

.stopped .avatar {
  filter: saturate(0.3);
  opacity: 0.75;
}

.avatar .dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 10px;
  height: 10px;
  border: 2px solid var(--s1);
}

.bot-title {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.name,
.account {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name {
  font-size: 15px;
}

.account {
  font-size: 12.5px;
  color: var(--fg3);
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
  white-space: nowrap;
}

.pill .dot {
  width: 6px;
  height: 6px;
  background: currentColor;
}

.pill.ok { color: var(--ok); background: var(--ok-soft); }
.pill.warn { color: var(--warn); background: var(--warn-soft); }
.pill.bad { color: var(--bad); background: var(--bad-soft); }
.pill.idle { color: var(--fg2); background: var(--s2); }

.bot-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 0 16px;
}

.conn {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--fg2);
}

.conn-icon {
  flex: none;
}

.mode {
  flex: none;
  font-size: 12px;
}

.address {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
}

.note {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12.5px;
  color: var(--fg3);
}

.note > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note.bad {
  align-items: flex-start;
  color: var(--bad);
}

.note.bad .n-icon {
  margin-top: 2px;
}

.note .clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  white-space: normal;
  line-height: 1.45;
}

.note.activity {
  color: inherit;
  text-decoration: none;
}

.bot-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 10px 16px;
  border-top: 1px solid var(--line);
  font-size: 12.5px;
  color: var(--fg2);
  cursor: default;
}

.add-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 196px;
  border: 1.5px dashed var(--line);
  border-radius: var(--radius);
  background: transparent;
  color: var(--fg2);
  font: inherit;
  cursor: pointer;
}

.add-card:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.plus {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  margin-bottom: 6px;
  border-radius: 50%;
  background: var(--primary-soft);
  color: var(--primary);
}

.add-card .hint {
  font-size: 12.5px;
  color: var(--fg3);
}

.no-match {
  padding: 48px 0;
}
</style>
