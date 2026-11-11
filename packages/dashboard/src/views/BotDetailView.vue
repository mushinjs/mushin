<script setup lang="ts">
import { Button, useConfirm, useToast } from '@mushinjs/ui'
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { call } from '../api'
import BotCommands from '../components/BotCommands.vue'
import BotConnection from '../components/BotConnection.vue'
import BotHome from '../components/BotHome.vue'
import BotLogs from '../components/BotLogs.vue'
import BotPermissions from '../components/BotPermissions.vue'
import BotPersonas from '../components/BotPersonas.vue'
import BotPlugins from '../components/BotPlugins.vue'
import LiveConversation from '../components/LiveConversation.vue'
import PageHeader from '../components/PageHeader.vue'
import BotRuns from '../components/runs/BotRuns.vue'
import { useDataStore } from '../stores/data'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const data = useDataStore()
const message = useToast()
const dialog = useConfirm()

const id = computed(() => String(route.params.id))
const tab = computed(() => String(route.params.tab))
const bot = computed(() => data.bots.find((item) => item.id === id.value))

onMounted(() => {
  if (!data.loadedBots) data.refreshBots().catch(() => {})
})

// The bot's pages, grouped by what you do there: watch it, shape how it behaves, or set it up.
interface Section { key: string, label: string, icon: string, target: string, count?: number }
const sections = computed<{ key: string, label: string, items: Section[] }[]>(() => [
  {
    key: 'observe',
    label: t('bot.groupObserve'),
    items: [
      { key: 'home', label: t('bot.home'), icon: 'i-lucide-layout-grid', target: 'bot.home' },
      { key: 'live', label: t('bot.live'), icon: 'i-lucide-message-circle-more', target: 'bot.live' },
      { key: 'runs', label: t('runs.tab'), icon: 'i-lucide-list', target: 'bot.runs' },
      { key: 'logs', label: t('bot.logs'), icon: 'i-lucide-file-text', target: 'bot.logs' },
    ],
  },
  {
    key: 'behave',
    label: t('bot.groupBehavior'),
    items: [
      { key: 'plugins', label: t('bot.plugins'), icon: 'i-lucide-puzzle', target: 'bot.plugins', count: bot.value?.plugins.filter((plugin) => plugin.enabled).length },
      { key: 'commands', label: t('bot.commands'), icon: 'i-lucide-code', target: 'bot.commands' },
      { key: 'personas', label: t('bot.personas'), icon: 'i-lucide-circle-user', target: 'bot.personas' },
    ],
  },
  {
    key: 'setup',
    label: t('bot.groupSettings'),
    items: [
      { key: 'connection', label: t('bot.connection'), icon: 'i-lucide-link', target: 'bot.connection' },
      { key: 'permissions', label: t('bot.permissions'), icon: 'i-lucide-shield-check', target: 'bot.permissions' },
      { key: 'danger', label: t('bot.danger'), icon: 'i-lucide-trash-2', target: 'bot.danger' },
    ],
  },
])

const current = computed(() => sections.value.flatMap((group) => group.items).find((item) => item.key === tab.value))

// One status for the header, the same as on the bot's card.
const state = computed(() => {
  const value = bot.value
  if (!value) return { cls: 'idle', text: '' }
  if (!value.enabled) return { cls: 'idle', text: t('bots.state.stopped') }
  if (value.status === 'error') return { cls: 'bad', text: t('bots.state.problem') }
  const cls = value.status === 'online' ? 'ok' : value.status === 'connecting' ? 'warn' : 'idle'
  return { cls, text: t(`bots.state.${value.status}`) }
})

const account = computed(() => (bot.value?.selfName ? `${bot.value.selfName} · ${bot.value.selfId}` : bot.value?.selfId ?? t('bots.notLoggedIn')))

async function run(action: string) {
  try {
    await call(action, { id: id.value })
    await data.refreshBots()
  } catch (error) {
    message.error((error as Error).message)
  }
}

function remove() {
  dialog.warning({
    title: t('common.confirmDelete', { name: bot.value?.name }),
    content: t('bots.deleteHint'),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await call('bots.delete', { id: id.value })
      message.success(t('common.deleted'))
      await data.refreshBots()
      router.push('/bots')
    },
  })
}
</script>

<template>
  <div class="page">
    <template v-if="bot">
      <PageHeader :title="bot.name" :lead="account">
        <template #before>
          <Button quaternary circle :aria-label="t('common.back')" class="back" icon="i-lucide-arrow-left" @click="router.push('/bots')" />
        </template>
        <template #title>
          {{ bot.name }}
          <span class="pill" :class="state.cls"><span class="dot" />{{ state.text }}</span>
        </template>
        <template v-if="bot.status === 'error' && bot.error" #lead>
          {{ account }} · <span class="error">{{ bot.error }}</span>
          · <RouterLink :to="`/bots/${id}/logs`">{{ t('bot.viewLogs') }}</RouterLink>
        </template>
        <Button v-if="bot.enabled" @click="run('bots.start')">{{ t('bots.restart') }}</Button>
        <Button v-if="bot.enabled" @click="run('bots.stop')">{{ t('common.stop') }}</Button>
        <Button v-else type="primary" @click="run('bots.start')">{{ t('common.start') }}</Button>
      </PageHeader>

      <div class="detail">
        <nav class="subnav" :aria-label="t('bot.sections')">
          <div v-for="group in sections" :key="group.key" class="subnav-group">
            <div class="subnav-title">{{ group.label }}</div>
            <RouterLink
              v-for="item in group.items"
              :key="item.key"
              :to="`/bots/${id}/${item.key}`"
              replace
              class="subnav-item"
              :class="{ on: tab === item.key, danger: item.key === 'danger' }"
              :aria-current="tab === item.key ? 'page' : undefined"
            >
              <span class="text-[16px]" :class="item.icon" />
              <span class="subnav-label">{{ item.label }}</span>
              <span v-if="item.count" class="subnav-count">{{ item.count }}</span>
            </RouterLink>
          </div>
        </nav>

        <section class="detail-body" :data-agent-target="current?.target">
          <h2 class="section-heading">{{ current?.label }}</h2>
          <BotHome v-if="tab === 'home'" :bot="bot" />
          <LiveConversation v-else-if="tab === 'live'" :bot-id="bot.id" />
          <BotRuns v-else-if="tab === 'runs'" :bot-id="bot.id" />
          <BotLogs v-else-if="tab === 'logs'" :bot-id="bot.id" />
          <BotPlugins v-else-if="tab === 'plugins'" :bot-id="bot.id" />
          <BotCommands v-else-if="tab === 'commands'" :bot="bot" />
          <BotPersonas v-else-if="tab === 'personas'" :bot="bot" />
          <BotConnection v-else-if="tab === 'connection'" :bot="bot" />
          <BotPermissions v-else-if="tab === 'permissions'" :bot="bot" />
          <div v-else-if="tab === 'danger'" class="danger-zone">
            <div class="danger-row">
              <span class="i-lucide-circle-alert danger-icon text-[20px]" />
              <div class="danger-text">
                <strong>{{ t('bot.deleteBot') }}</strong>
                <p>{{ t('bots.deleteHint') }}</p>
              </div>
              <Button type="error" @click="remove">{{ t('common.delete') }}</Button>
            </div>
          </div>
        </section>
      </div>
    </template>

    <p v-else-if="data.loadedBots">{{ t('bots.notFound') }}</p>
  </div>
</template>

<style scoped>
.back {
  margin: -2px 0 0 -8px;
}

.error {
  color: var(--bad);
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
  border-radius: 50%;
  background: currentColor;
}

.pill.ok { color: var(--ok); background: var(--ok-soft); }
.pill.warn { color: var(--warn); background: var(--warn-soft); }
.pill.bad { color: var(--bad); background: var(--bad-soft); }
.pill.idle { color: var(--fg2); background: var(--s2); }

/* A left column of the bot's pages, the page itself beside it. */
.detail {
  display: grid;
  grid-template-columns: 184px minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}

.subnav {
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.subnav-title {
  padding: 0 10px 6px;
  font-size: 12px;
  letter-spacing: 0.06em;
  color: var(--fg3);
}

.subnav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 10px;
  border-radius: 8px;
  color: var(--fg2);
  white-space: nowrap;
  transition: background-color 0.15s, color 0.15s;
}

.subnav-item:hover {
  background: var(--s2);
  color: var(--fg);
  text-decoration: none;
}

.subnav-item.on {
  background: var(--primary-soft);
  color: var(--primary);
  font-weight: 600;
}

.subnav-item.danger:hover,
.subnav-item.danger.on {
  background: var(--bad-soft);
  color: var(--bad);
}

.subnav-item:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}

.subnav-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.subnav-count {
  font-size: 12px;
  color: var(--fg3);
  font-variant-numeric: tabular-nums;
}

.detail-body {
  min-width: 0;
}

.section-heading {
  margin: 4px 0 16px;
  font-size: 16px;
  font-weight: 600;
}

.danger-zone {
  border: 1px solid color-mix(in srgb, var(--bad) 35%, var(--line));
  border-radius: var(--radius);
  background: var(--s1);
}

.danger-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 18px;
}

.danger-icon {
  flex: none;
  color: var(--bad);
}

.danger-text {
  flex: 1;
  min-width: 0;
}

.danger-text p {
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--fg2);
}

/* Narrow windows: the sections become a scrolling row above the page. */
@media (max-width: 900px) {
  .detail {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }

  .subnav {
    position: static;
    flex-direction: row;
    gap: 4px;
    overflow-x: auto;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--line);
  }

  .subnav-group {
    display: flex;
    gap: 2px;
  }

  .subnav-group + .subnav-group {
    padding-left: 6px;
    border-left: 1px solid var(--line);
  }

  .subnav-title {
    display: none;
  }

  .section-heading {
    display: none;
  }
}
</style>
