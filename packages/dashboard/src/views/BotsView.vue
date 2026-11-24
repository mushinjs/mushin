<script setup lang="ts">
import { Button, Empty, Input, Tooltip, useToast } from '@mushinjs/ui'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { call } from '../api'
import AdapterIcon from '../components/AdapterIcon.vue'
import BotWizard from '../components/BotWizard.vue'
import EmptyState from '../components/EmptyState.vue'
import PageHeader from '../components/PageHeader.vue'
import BotActivity from '../components/runs/BotActivity.vue'
import { avatarColor, initial } from '../botAvatar'
import { useDataStore } from '../stores/data'
import type { AppPlugin, Bot, CatalogEntry } from '../types'
import { localize } from '../utils'

const { t, locale } = useI18n()
const router = useRouter()
const data = useDataStore()
const message = useToast()
const route = useRoute()
const showCreate = ref(false)
// /bots?new=1 (from search) opens the add dialog.
if (route.query.new) {
  showCreate.value = true
  router.replace({ query: { ...route.query, new: undefined } })
}
const busy = ref<string>()
// Avatars that failed to load (offline, blocked), so those cards fall back to the initial.
const brokenAvatars = ref(new Set<string>())
const avatarOf = (bot: Bot) => (bot.selfAvatar && !brokenAvatars.value.has(bot.selfAvatar) ? bot.selfAvatar : undefined)

onMounted(() => data.refreshBots().catch((error) => message.error(error.message)))

// Plugin names for the hover list on each card: bot plugins from the catalog, app plugins as installed.
const pluginNames = ref(new Map<string, string>())
onMounted(async () => {
  const [catalog, installed] = await Promise.all([
    call<CatalogEntry[]>('plugins.catalog', { kind: 'bot' }).catch(() => [] as CatalogEntry[]),
    call<AppPlugin[]>('plugins.list').catch(() => [] as AppPlugin[]),
  ])
  const names = new Map<string, string>()
  for (const entry of catalog) names.set(entry.package, localize(entry.manifest.displayName, locale.value))
  for (const plugin of installed) if (plugin.manifest) names.set(plugin.package, localize(plugin.manifest.displayName, locale.value))
  pluginNames.value = names
})
const pluginLabel = (pkg: string) => pluginNames.value.get(pkg) || pkg.replace(/^@mushinjs\/(bot-)?plugin-/, '')
const enabledList = (bot: Bot) => [...bot.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.package), ...(bot.appPlugins ?? [])].map(pluginLabel)
const adapterOf = (bot: Bot) => data.adapters.find((item) => item.id === bot.adapter.type)

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
    return [bot.name, bot.selfName, bot.selfId].some((value) => value?.toLowerCase().includes(text))
  })
})

const account = (bot: Bot) => (bot.selfName ? `${bot.selfName} · ${bot.selfId}` : bot.selfId ?? t('bots.notLoggedIn'))
const open = (bot: Bot) => router.push(`/bots/${bot.id}`)
</script>

<template>
  <div class="page">
    <PageHeader :title="t('nav.bots')" :lead="t('bots.lead')">
      <Button type="primary" data-fairy-target="bots.add" icon="i-lucide-plus" @click="showCreate = true">
        {{ t('bots.add') }}
      </Button>
    </PageHeader>

    <div v-if="data.bots.length > 1" class="toolbar">
      <Input v-model:value="query" clearable :placeholder="t('bots.search')" class="search">
        <template #prefix><span class="i-lucide-search" /></template>
      </Input>
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
        <AdapterIcon :adapter="adapterOf(bot)" :size="112" class="watermark" />
        <div class="bot-head">
          <div class="avatar" :style="{ background: avatarColor(bot.id) }" aria-hidden="true">
            <img
              v-if="avatarOf(bot)"
              :src="avatarOf(bot)"
              alt=""
              class="avatar-img"
              referrerpolicy="no-referrer"
              @error="brokenAvatars.add(bot.selfAvatar!)"
            >
            <template v-else>{{ initial(bot.name) }}</template>
            <span class="dot" :class="stateClass[stateOf(bot)]" />
          </div>
          <div class="bot-title">
            <strong class="name">{{ bot.name }}</strong>
            <span class="account">{{ account(bot) }}</span>
          </div>
          <span class="pill" :class="stateClass[stateOf(bot)]"><span class="dot" />{{ stateLabel(stateOf(bot)) }}</span>
        </div>

        <div class="bot-body">
          <div v-if="stateOf(bot) === 'problem'" class="note bad" :title="bot.error">
            <span class="i-lucide-circle-alert note-icon text-[15px]" />
            <span class="clamp">{{ bot.error || t('bots.state.problem') }}</span>
          </div>
          <RouterLink v-else-if="stateOf(bot) === 'online'" :to="`/bots/${bot.id}/runs`" class="note activity" @click.stop>
            <BotActivity :bot-id="bot.id" />
          </RouterLink>
          <div v-else class="note">
            <span class="i-lucide-clock text-[15px]" />
            <span>{{ stateOf(bot) === 'connecting' ? t('bots.connectingHint') : stateOf(bot) === 'stopped' ? t('bots.stoppedHint') : t('bots.offlineHint') }}</span>
          </div>
        </div>

        <div class="bot-foot" @click.stop>
          <Tooltip placement="bottom" :show-arrow="false" class="plugin-tip">
            <template #trigger>
              <RouterLink :to="`/bots/${bot.id}/plugins`" class="plugins-link">
                <span class="i-lucide-puzzle text-[14px]" />{{ t('bots.pluginCount', enabledList(bot).length) }}
              </RouterLink>
            </template>
            <ul v-if="enabledList(bot).length" class="tip-list">
              <li v-for="label in enabledList(bot)" :key="label">{{ label }}</li>
            </ul>
            <span v-else>{{ t('bots.noPluginsTip') }}</span>
          </Tooltip>
          <Button v-if="bot.enabled" size="small" quaternary class="stop" :loading="busy === bot.id" icon="i-lucide-square" @click="toggle(bot, false)">
            {{ t('common.stop') }}
          </Button>
          <Button v-else size="small" secondary type="primary" :loading="busy === bot.id" icon="i-lucide-play" @click="toggle(bot, true)">
            {{ t('common.start') }}
          </Button>
        </div>
      </article>

      <button v-if="filter === 'all' && !query" type="button" class="add-card" @click="showCreate = true">
        <span class="plus"><span class="i-lucide-plus text-[20px]" /></span>
        <strong>{{ t('bots.add') }}</strong>
        <span class="hint">{{ t('bots.addHint') }}</span>
      </button>
    </div>

    <Empty v-if="data.bots.length && !shown.length" :description="t('bots.noMatch')" class="no-match" />

    <EmptyState v-else-if="!data.bots.length && data.loadedBots" icon="i-lucide-messages-square" :title="t('bots.emptyTitle')" :hint="t('bots.emptyHint')">
      <Button type="primary" @click="showCreate = true">{{ t('bots.add') }}</Button>
    </EmptyState>

    <BotWizard v-model:show="showCreate" />
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
  gap: 20px;
}

.bot {
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 184px;
  min-width: 0;
  overflow: hidden;
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
  padding: 18px 18px 14px;
}

/* The platform's logo, faint behind the right of the card. */
.watermark {
  position: absolute;
  top: 50%;
  right: -22px;
  opacity: 0.07;
  transform: translateY(-50%) rotate(-8deg);
  pointer-events: none;
}

.stopped .watermark {
  filter: grayscale(1);
}

.bot-head,
.bot-body,
.bot-foot {
  position: relative;
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

.avatar-img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  background: var(--s2);
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
  padding: 0 18px 12px;
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

.note.bad .note-icon {
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
  padding: 8px 12px 8px 18px;
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
  height: 184px;
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

.stop {
  color: var(--bad);
}

.stop:not(:disabled):hover {
  border-color: var(--bad);
  background: var(--bad-soft);
  color: var(--bad);
}

.plugins-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--fg2);
  text-decoration: none;
}

.plugins-link:hover {
  color: var(--primary);
  text-decoration: none;
}

.tip-list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}

.tip-list li::before {
  content: '· ';
  opacity: 0.6;
}

.no-match {
  padding: 48px 0;
}
</style>
