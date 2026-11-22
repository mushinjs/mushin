<script setup lang="ts">
import { Button, Spin } from '@mushinjs/ui'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call, on } from '../../api'
import { useDataStore } from '../../stores/data'
import { useFairyStore } from '../../stores/fairy'
import { useRunsStore } from '../../stores/runs'
import { workspace } from '../../stores/workspace'
import type { AppPlugin } from '../../types'
import { localize } from '../../utils'
import StatusBadge from '../StatusBadge.vue'

/** The panel's status tab: bots, app plugins (failed first), flow runs going on, and Fairy's running conversations. */
const { t, locale } = useI18n()
const data = useDataStore()
const runs = useRunsStore()
const fairy = useFairyStore()

const plugins = ref<AppPlugin[]>([])
const loading = ref(false)

async function refreshPlugins() {
  loading.value = true
  try {
    plugins.value = await call<AppPlugin[]>('plugins.list')
  } catch {
  } finally {
    loading.value = false
  }
}

const RANK: Record<string, number> = { failed: 0, error: 0, pending: 1, missing: 1, active: 2, disabled: 3 }
const sortedPlugins = computed(() => [...plugins.value].sort((a, b) => (RANK[a.status] ?? 2) - (RANK[b.status] ?? 2)))
const failed = computed(() => plugins.value.filter((plugin) => RANK[plugin.status] === 0).length)
const liveRuns = computed(() => [...runs.live.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 8))
const working = computed(() => fairy.sessions.filter((session) => session.running))

// Narrow, the badges shrink to colored dots so names have room; the status is on hover.
const root = ref<HTMLElement>()
const narrow = ref(false)
const observer = new ResizeObserver(([entry]) => (narrow.value = (entry?.contentRect.width ?? 0) < 320))
onMounted(() => root.value && observer.observe(root.value))
onBeforeUnmount(() => observer.disconnect())

let off: (() => void) | undefined
onMounted(() => {
  refreshPlugins()
  runs.refresh().catch(() => {})
  off = on('manager/changed', () => refreshPlugins())
})
onBeforeUnmount(() => off?.())

const show = (path: string, title?: string) => workspace.openView({ kind: 'page', path, ...(title ? { title } : {}) })
</script>

<template>
  <div ref="root" class="status">
    <section>
      <h3>{{ t('workspace.status.bots') }} <span class="count">{{ data.bots.length }}</span></h3>
      <p v-if="!data.bots.length" class="muted">{{ t('workspace.status.noBots') }}</p>
      <button v-for="bot in data.bots" :key="bot.id" type="button" class="item" @click="show(`/bots/${bot.id}/home`, bot.name)">
        <span class="i-lucide-bot item-icon" />
        <span class="item-name">{{ bot.name }}</span>
        <span v-if="runs.activityOf(bot.id).state !== 'idle'" class="activity">{{ t(`workspace.status.activity.${runs.activityOf(bot.id).state}`) }}</span>
        <StatusBadge :status="bot.status" :error="bot.error" :dot="narrow" />
      </button>
    </section>

    <section>
      <h3>
        {{ t('workspace.status.plugins') }} <span class="count">{{ plugins.length }}</span>
        <span v-if="failed" class="bad">{{ t('workspace.status.failed', { n: failed }) }}</span>
        <Button size="tiny" quaternary circle icon="i-lucide-refresh-cw" :loading="loading" :aria-label="t('workspace.status.refresh')" @click="refreshPlugins" />
      </h3>
      <button v-for="plugin in sortedPlugins" :key="plugin.id" type="button" class="item" :title="plugin.error ?? plugin.package" @click="show(`/plugins?highlight=${encodeURIComponent(plugin.package)}`)">
        <span class="i-lucide-puzzle item-icon" />
        <span class="item-name">{{ localize(plugin.manifest?.displayName, locale) || plugin.package }}</span>
        <StatusBadge :status="plugin.status" :error="plugin.error" :dot="narrow" />
      </button>
    </section>

    <section>
      <h3>{{ t('workspace.status.runs') }} <span class="count">{{ liveRuns.length }}</span></h3>
      <p v-if="!liveRuns.length" class="muted">{{ t('workspace.status.noRuns') }}</p>
      <button v-for="run in liveRuns" :key="run.id" type="button" class="item" @click="show(`/flows/${run.flowId}?run=${run.id}`, run.flowName)">
        <Spin :size="12" class="item-icon" />
        <span class="item-name">{{ run.flowName }}</span>
        <span class="muted run-node">{{ run.node?.label ?? run.node?.type ?? run.text }}</span>
      </button>
    </section>

    <section v-if="working.length">
      <h3>{{ t('workspace.status.fairy') }} <span class="count">{{ working.length }}</span></h3>
      <div v-for="session in working" :key="session.id" class="item static">
        <Spin :size="12" class="item-icon" />
        <span class="item-name">{{ session.title || t('fairy.untitled') }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.status {
  padding: 12px 14px 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  font-size: 13px;
}

h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg2);
}

.count {
  color: var(--fg3);
  font-weight: 400;
}

.bad {
  color: var(--bad);
  font-weight: 400;
  margin-right: auto;
}

.muted {
  margin: 0;
  color: var(--fg3);
}

.item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.item:not(.static):hover {
  background: var(--s2);
}

.item.static {
  cursor: default;
}

.item-icon {
  flex: none;
  color: var(--fg3);
}

.item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.activity {
  color: var(--primary);
  font-size: 12px;
}

.run-node {
  max-width: 40%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
}
</style>
