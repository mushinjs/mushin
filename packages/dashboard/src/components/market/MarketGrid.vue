<script setup lang="ts">
import { Button, Input, Popover, Select, Spin, Toggle, Tooltip, useToast } from '@mushinjs/ui'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../../api'
import { installBlocker, loadMarket, market, type MarketItem } from '../../market'
import { groupOf, GROUPS, type GroupKey } from '../../plugins/groups'
import { GROUP_ICONS } from '../../plugins/item'
import { localize } from '../../utils'

/**
 * The market tab of the Plugins page: plugin packages from the market index (or npm), as cards to filter by group
 * and origin, sort, inspect on hover and install. The search box is the page's.
 */
const props = defineProps<{
  query: string
  /** Whether an installed package is turned on, from the installed list. */
  enabledOf: (name: string) => boolean | undefined
}>()
const emit = defineEmits<{ open: [entry: MarketItem]; install: [entry: MarketItem]; enable: [entry: MarketItem]; update: [entry: MarketItem] }>()
const { t, locale } = useI18n()
const message = useToast()

onMounted(() => loadMarket())

type Origin = 'all' | 'official' | 'community'
type Sort = 'downloads' | 'updated' | 'name'
const group = ref<GroupKey | 'all'>('all')
const origin = ref<Origin>('all')
const sort = ref<Sort>('downloads')

const listing = computed(() => market.listing)
const blocker = computed(() => installBlocker(listing.value))
const nameOf = (entry: MarketItem) => localize(entry.displayName, locale.value) || entry.name
const descOf = (entry: MarketItem) => localize(entry.description, locale.value)
const groupOfEntry = (entry: MarketItem) => groupOf({ package: entry.name, kind: entry.kind, name: entry.name, category: entry.category, enabled: false, requires: [] })

const matching = computed(() => {
  const text = props.query.trim().toLowerCase()
  return (listing.value?.entries ?? []).filter((entry) => {
    if (origin.value === 'official' && !entry.official) return false
    if (origin.value === 'community' && entry.official) return false
    return !text || [entry.name, nameOf(entry), descOf(entry), ...(entry.keywords ?? [])].some((value) => value.toLowerCase().includes(text))
  })
})

/** The group chips: those with something in them, in the installed list's order. */
const groups = computed(() => GROUPS.filter((key) => matching.value.some((entry) => groupOfEntry(entry) === key)))

const shown = computed(() => {
  const list = matching.value.filter((entry) => group.value === 'all' || groupOfEntry(entry) === group.value)
  const by: Record<Sort, (a: MarketItem, b: MarketItem) => number> = {
    downloads: (a, b) => (b.downloads ?? 0) - (a.downloads ?? 0),
    updated: (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    name: (a, b) => nameOf(a).localeCompare(nameOf(b), locale.value),
  }
  return [...list].sort((a, b) => by[sort.value](a, b) || a.name.localeCompare(b.name))
})

const sortOptions = computed(() => (['downloads', 'updated', 'name'] as const).map((value) => ({ value, label: t(`market.sort.${value}`) })))

const relative = (iso?: string) => {
  if (!iso) return ''
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000)
  const rtf = new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' })
  if (Math.abs(days) < 30) return rtf.format(-days, 'day')
  if (Math.abs(days) < 365) return rtf.format(-Math.round(days / 30), 'month')
  return rtf.format(-Math.round(days / 365), 'year')
}
const compact = (n?: number) => (n === undefined ? '' : new Intl.NumberFormat(locale.value, { notation: 'compact' }).format(n))
const summary = (text?: string) => (text ?? '').replace(/```[\s\S]*?```/g, '').replace(/[#>*_`[\]]|\(http[^)]*\)/g, '').replace(/\n{2,}/g, '\n').trim().slice(0, 360)

/** What the card's button does now. */
function stateOf(entry: MarketItem): { key: 'install' | 'update' | 'enable' | 'installed' | 'incompatible' | 'blocked'; reason?: string } {
  if (entry.installed) {
    if (entry.update && !entry.installed.builtin) return { key: 'update' }
    if (entry.kind === 'app' && props.enabledOf(entry.name) === false) return { key: 'enable' }
    return { key: 'installed' }
  }
  if (!entry.choice.version) return { key: 'incompatible', reason: t('market.needs', { range: entry.choice.needs }) }
  if (!entry.allowed) return { key: 'blocked', reason: t('market.notAllowed') }
  if (blocker.value) return { key: 'blocked', reason: blocker.value === 'development' ? t('market.development') : t('market.needsSupervisor') }
  return { key: 'install' }
}

function act(entry: MarketItem) {
  const state = stateOf(entry).key
  if (state === 'install') emit('install', entry)
  else if (state === 'update') emit('update', entry)
  else if (state === 'enable') emit('enable', entry)
  else emit('open', entry)
}

// ---- settings ----

const settingsOpen = ref(false)
const indexesText = ref('')
const savingSettings = ref(false)
function openSettings(open: boolean) {
  settingsOpen.value = open
  if (open) indexesText.value = (listing.value?.settings.indexes ?? []).join('\n')
}
async function saveSettings(input: Record<string, unknown>) {
  savingSettings.value = true
  try {
    await call('market.settings', input)
    message.success(t('market.saved'))
    await loadMarket(true)
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    savingSettings.value = false
  }
}
const MIRROR = 'https://registry.npmmirror.com/'
const NPM = 'https://registry.npmjs.org/'
</script>

<template>
  <div class="market">
    <div class="bar">
      <div class="chips" role="radiogroup">
        <button type="button" class="chip" :class="{ on: group === 'all' }" @click="group = 'all'">{{ t('plugins.filter.all') }}</button>
        <button v-for="key in groups" :key="key" type="button" class="chip" :class="{ on: group === key }" @click="group = key">
          <span :class="GROUP_ICONS[key]" class="chip-icon" />{{ t(`plugins.groups.${key}`) }}
        </button>
      </div>
      <div class="chips">
        <button v-for="key in (['all', 'official', 'community'] as const)" :key="key" type="button" class="chip small" :class="{ on: origin === key }" @click="origin = key">{{ t(`market.filterOrigin.${key}`) }}</button>
      </div>
      <Select v-model:value="sort" class="sort" size="small" :options="sortOptions" :aria-label="t('market.sortLabel')" />
    </div>

    <div v-if="listing" class="source">
      <span>{{ listing.source === 'index' ? t('market.source.index') : t('market.source.npm') }}</span>
      <Tooltip v-if="listing.indexError" :max-width="420">
        <template #trigger><span class="i-lucide-triangle-alert warn-icon" /></template>
        {{ t('market.source.indexFailed', { error: listing.indexError }) }}
      </Tooltip>
      <span class="sep">·</span>
      <span class="mono">{{ t('market.registry', { registry: listing.registry }) }}</span>
      <span class="sep">·</span>
      <span>{{ t('market.checked', { time: relative(new Date(listing.fetchedAt).toISOString()) }) }}</span>
      <Button text size="tiny" icon="i-lucide-refresh-cw" :loading="market.loading" @click="loadMarket(true)">{{ t('market.refresh') }}</Button>
      <Popover :show="settingsOpen" placement="bottom" align="end" :width="380" @update:show="openSettings">
        <template #trigger><Button text size="tiny" icon="i-lucide-settings-2">{{ t('market.settings') }}</Button></template>
        <div class="settings">
          <label class="field">
            <span>{{ t('market.indexes') }}</span>
            <Input v-model:value="indexesText" type="textarea" class="mono" :autosize="{ minRows: 2, maxRows: 5 }" />
            <small>{{ t('market.indexesHint') }}</small>
          </label>
          <Button size="small" :loading="savingSettings" @click="saveSettings({ indexes: indexesText.split(/\s+/).filter(Boolean) })">{{ t('common.save') }}</Button>
          <div class="field row">
            <span>{{ t('market.curatedOnly') }}</span>
            <Toggle :value="listing.settings.curatedOnly" size="small" @update:value="(value: boolean) => saveSettings({ curatedOnly: value })" />
          </div>
          <div class="field">
            <span>{{ t('market.registryLabel') }}</span>
            <span class="mono small">{{ listing.registry }}</span>
            <Button v-if="listing.registry !== MIRROR" size="small" :loading="savingSettings" @click="saveSettings({ registry: MIRROR })">{{ t('market.useMirror') }}</Button>
            <Button v-else size="small" :loading="savingSettings" @click="saveSettings({ registry: NPM })">{{ t('market.useNpm') }}</Button>
          </div>
        </div>
      </Popover>
    </div>
    <p v-if="blocker" class="faint">{{ blocker === 'development' ? t('market.development') : t('market.needsSupervisor') }}</p>
    <p v-if="market.error" class="error">{{ t('market.loadFailed', { error: market.error }) }}</p>

    <Spin :show="market.loading && !listing">
      <div v-if="shown.length" class="grid">
        <Tooltip v-for="entry in shown" :key="entry.name" :max-width="420" placement="bottom" :delay="500" :show-arrow="false">
          <template #trigger>
            <article class="card" tabindex="0" @click="emit('open', entry)" @keydown.enter="emit('open', entry)">
              <div class="top">
                <span class="icon"><span :class="GROUP_ICONS[groupOfEntry(entry)]" /></span>
                <div class="title">
                  <strong>{{ nameOf(entry) }}</strong>
                  <span class="mono pkg">{{ entry.name }}</span>
                </div>
              </div>
              <p class="desc">{{ descOf(entry) }}</p>
              <div class="badges">
                <span class="badge cat">{{ t(`plugins.groups.${groupOfEntry(entry)}`) }}</span>
                <span v-if="entry.official" class="badge official">{{ t('market.official') }}</span>
                <span v-if="entry.installed?.builtin" class="badge" :title="t('market.builtinHint')">{{ t('market.builtin') }}</span>
                <span v-if="entry.curated" class="badge curated">{{ t('market.curated') }}</span>
                <span v-if="entry.trusted && !entry.official" class="badge trusted" :title="t('market.trustedHint')">{{ t('market.trusted') }}</span>
              </div>
              <!-- Room for the counts of a content pack (flows, tests, pages), which come later. -->
              <div class="foot">
                <span v-if="entry.downloads !== undefined" class="stat"><span class="i-lucide-download" />{{ compact(entry.downloads) }}</span>
                <span v-if="entry.updatedAt" class="stat">{{ relative(entry.updatedAt) }}</span>
                <span class="spacer" />
                <Button
                  size="small"
                  :type="['install', 'update', 'enable'].includes(stateOf(entry).key) ? 'primary' : 'default'"
                  :secondary="stateOf(entry).key === 'enable'"
                  :disabled="['incompatible', 'blocked'].includes(stateOf(entry).key)"
                  :title="stateOf(entry).reason"
                  @click.stop="act(entry)"
                >
                  {{ { install: t('market.install'), update: t('market.update'), enable: t('market.enable'), installed: t('market.installedState'), incompatible: t('market.incompatible'), blocked: t('market.install') }[stateOf(entry).key] }}
                </Button>
              </div>
            </article>
          </template>
          <div class="tip">
            <strong>{{ entry.name }}@{{ entry.version }}</strong>
            <span v-if="summary(entry.readme)" class="tip-readme">{{ summary(entry.readme) }}</span>
            <span v-if="entry.requires?.plugins">{{ t('market.requires') }}：{{ Object.keys(entry.requires.plugins).join(t('plugins.listSeparator')) }}</span>
            <span v-if="entry.platforms?.length">{{ t('market.platforms') }}：{{ entry.platforms.join(', ') }}</span>
            <span v-if="entry.requires?.mushin">{{ t('market.needsRange', { range: entry.requires.mushin }) }}</span>
            <span v-if="stateOf(entry).reason" class="tip-warn">{{ stateOf(entry).reason }}</span>
          </div>
        </Tooltip>
      </div>
      <p v-else-if="listing" class="faint none">{{ listing.entries.length ? t('market.empty') : t('market.nothing') }}</p>
    </Spin>
  </div>
</template>

<style scoped>
.market {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 11px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--s1);
  color: var(--fg2);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.chip.small {
  height: 26px;
}

.chip.on {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
}

.chip-icon {
  font-size: 13px;
}

.sort {
  width: 140px;
  margin-left: auto;
}

.source {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  font-size: 12px;
  color: var(--fg3);
}

.warn-icon {
  color: var(--warn);
}

.sep {
  opacity: 0.6;
}

.settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field.row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.field small {
  color: var(--fg3);
  font-size: 11.5px;
}

.small {
  font-size: 12px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 170px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.card:hover,
.card:focus-visible {
  border-color: var(--primary);
  box-shadow: var(--shadow-pop);
  outline: none;
}

.top {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: var(--s2);
  color: var(--fg2);
  font-size: 18px;
}

.title {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pkg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--fg3);
}

.desc {
  flex: 1;
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 11px;
  background: var(--s2);
  color: var(--fg2);
}

.badge.official { background: var(--primary-soft); color: var(--primary); }
.badge.trusted { background: var(--ok-soft); color: var(--ok); }
.badge.curated { background: var(--warn-soft); color: var(--warn); }

.foot {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--fg3);
}

.stat {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.spacer {
  flex: 1;
}

.tip {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tip-readme {
  white-space: pre-line;
  opacity: 0.85;
}

.tip-warn {
  color: #fca5a5;
}

.faint {
  margin: 0;
  font-size: 12.5px;
  color: var(--fg3);
}

.error {
  margin: 0;
  font-size: 12.5px;
  color: var(--bad);
}

.none {
  padding: 24px 0;
}
</style>
