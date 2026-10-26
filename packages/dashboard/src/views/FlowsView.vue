<script setup lang="ts">
import {
  AddOutline, AlertCircleOutline, AppsOutline, ChatbubblesOutline, CloseCircleOutline, ExtensionPuzzleOutline, FilterOutline, GitNetworkOutline,
  LayersOutline, ListOutline, NotificationsOutline, PauseCircleOutline, PlayCircleOutline, SearchOutline, SparklesOutline, SwapVerticalOutline, TimeOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import {
  type DataTableColumns, NBadge, NButton, NCard, NDataTable, NEmpty, NForm, NFormItem, NGrid, NGridItem, NIcon, NInput, NModal, NPopover,
  NRadioButton, NRadioGroup, NSelect, type SelectOption, NSwitch, NTag, useDialog, useMessage,
} from 'naive-ui'
import { type Component, computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { call, on } from '../api'
import { nodeIcon } from '../components/flow/icons'
import IconAction from '../components/IconAction.vue'
import { flowTemplates } from '../flow'
import { useDataStore } from '../stores/data'
import type { FlowDoc, FlowSummary } from '../types'
import { formatTime, localize } from '../utils'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const data = useDataStore()
const flows = ref<FlowSummary[]>([])
const loaded = ref(false)

async function refresh() {
  flows.value = await call<FlowSummary[]>('flows.list')
  loaded.value = true
}

onMounted(() => {
  refresh().catch((error) => message.error(error.message))
  if (!data.loadedBots) data.refreshBots().catch(() => {})
})
const off = on('flows/changed', () => refresh().catch(() => {}))
onBeforeUnmount(off)

const botName = (id: string) => data.bots.find((bot) => bot.id === id)?.name ?? id
const botOptions = computed(() => data.bots.map((bot) => ({ label: bot.name, value: bot.id })))

// ---- view, grouping, filters and sorting (kept in the URL) ----

type View = 'cards' | 'list'
type Group = 'none' | 'trigger' | 'adapter' | 'bot' | 'recent'
type Sort = 'updated' | 'created' | 'name'
type TriggerKind = 'message' | 'keyword' | 'command' | 'regex' | 'schedule' | 'event'
type Status = 'enabled' | 'disabled' | 'errors'

const VIEW_KEY = 'mushin.flows.view'
const list = (value: unknown) => (typeof value === 'string' && value ? value.split(',') : [])
const savedView = (() => {
  try {
    return localStorage.getItem(VIEW_KEY) as View | null
  } catch {
    return null
  }
})()

const search = ref(String(route.query.q ?? ''))
const view = ref<View>((route.query.view as View) || savedView || 'cards')
const DEFAULT_GROUP: Group = 'bot'
const group = ref<Group>((route.query.group as Group) || DEFAULT_GROUP)
const sort = ref<Sort>((route.query.sort as Sort) || 'updated')
const triggerFilter = ref<string[]>(list(route.query.trigger))
const adapterFilter = ref<string[]>(list(route.query.adapter))
const botFilter = ref<string[]>(list(route.query.bot))
const statusFilter = ref<string[]>(list(route.query.status))

watch([search, view, group, sort, triggerFilter, adapterFilter, botFilter, statusFilter], () => {
  const query: Record<string, string> = {}
  if (search.value) query.q = search.value
  if (view.value !== 'cards') query.view = view.value
  if (group.value !== DEFAULT_GROUP) query.group = group.value
  if (sort.value !== 'updated') query.sort = sort.value
  if (triggerFilter.value.length) query.trigger = triggerFilter.value.join(',')
  if (adapterFilter.value.length) query.adapter = adapterFilter.value.join(',')
  if (botFilter.value.length) query.bot = botFilter.value.join(',')
  if (statusFilter.value.length) query.status = statusFilter.value.join(',')
  router.replace({ query })
  try {
    localStorage.setItem(VIEW_KEY, view.value)
  } catch {}
})

/** What kind of trigger a node is, for grouping and filtering. */
function kindOf(trigger: FlowSummary['triggers'][number]): TriggerKind {
  if (trigger.source === 'event') return 'event'
  if (trigger.source === 'schedule') return 'schedule'
  const kind = trigger.type.replace(/^trigger\./, '')
  return (['message', 'keyword', 'command', 'regex'] as const).includes(kind as any) ? kind as TriggerKind : 'message'
}
const kindsOf = (flow: FlowSummary) => [...new Set(flow.triggers.filter((item) => !item.skip).map(kindOf))]
const triggerKinds: TriggerKind[] = ['command', 'keyword', 'message', 'regex', 'schedule', 'event']

const adapterLabel = (id?: string) => {
  if (!id) return t('flows.adapterAny')
  return localize(data.adapters.find((adapter) => adapter.id === id)?.displayName, locale.value) || id
}

/**
 * The adapter a flow is for: the one set on it, or else the adapter its bots all use. Flows made
 * before adapters could be picked (or by the demo plugin) have none set but run on one anyway.
 */
function adapterOf(flow: FlowSummary) {
  if (flow.adapter) return flow.adapter
  const used = new Set(flow.bots.map((id) => data.bots.find((bot) => bot.id === id)?.adapter.type).filter(Boolean))
  return used.size === 1 ? [...used][0]! : ''
}

const kindIcon = (kind: string): Component => (kind === 'event' ? NotificationsOutline : nodeIcon(`trigger.${kind}`, 'trigger'))
const statusIcons: Record<Status, Component> = { enabled: PlayCircleOutline, disabled: PauseCircleOutline, errors: AlertCircleOutline }
const groupIcons: Record<Group, Component> = { none: AppsOutline, trigger: NotificationsOutline, adapter: ExtensionPuzzleOutline, bot: ChatbubblesOutline, recent: TimeOutline }
const icon = (component: Component, size = 15) => h(NIcon, { size, style: { flex: 'none' } }, { default: () => h(component) })

/** Select options shown with their icon. */
// Styled inline: the dropdown is rendered outside this component, where its scoped styles do not reach.
const renderLabel = (option: SelectOption & { icon?: Component }) => h('span', {
  style: { display: 'inline-flex', alignItems: 'center', gap: '8px', lineHeight: 1, verticalAlign: 'middle' },
}, [option.icon ? icon(option.icon) : null, h('span', null, String(option.label))])

const adapterIds = computed(() => {
  const ids = new Set(data.adapters.map((adapter) => adapter.id))
  for (const flow of flows.value) ids.add(adapterOf(flow))
  return [...ids].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
})
const groupOptions = computed(() => (['bot', 'trigger', 'adapter', 'recent', 'none'] as Group[]).map((value) => ({ label: t(`flows.groupBy.${value}`), value, icon: groupIcons[value] })))
const sortOptions = computed(() => (['updated', 'created', 'name'] as Sort[]).map((value) => ({ label: t(`flows.sortBy.${value}`), value })))

/** The filter panel: one section per field, each a row of toggles with icons. */
const filterSections = computed(() => [
  { key: 'trigger', title: t('flows.filterTrigger'), model: triggerFilter, items: triggerKinds.map((kind) => ({ value: kind, label: t(`flows.kind.${kind}`), icon: kindIcon(kind) })) },
  { key: 'adapter', title: t('flows.filterAdapter'), model: adapterFilter, items: adapterIds.value.map((id) => ({ value: id, label: adapterLabel(id || undefined), icon: ExtensionPuzzleOutline })) },
  { key: 'bot', title: t('flows.filterBot'), model: botFilter, items: data.bots.map((bot) => ({ value: bot.id, label: bot.name, icon: ChatbubblesOutline })) },
  { key: 'status', title: t('flows.filterStatus'), model: statusFilter, items: (['enabled', 'disabled', 'errors'] as Status[]).map((value) => ({ value, label: t(`flows.status.${value}`), icon: statusIcons[value] })) },
])

function toggleFilter(model: { value: string[] }, value: string) {
  model.value = model.value.includes(value) ? model.value.filter((item) => item !== value) : [...model.value, value]
}

/** Every active filter as a removable tag. */
const activeFilters = computed(() => filterSections.value.flatMap((section) => section.items
  .filter((item) => section.model.value.includes(item.value))
  .map((item) => ({ key: `${section.key}:${item.value}`, label: item.label, icon: item.icon, remove: () => toggleFilter(section.model, item.value) }))))
const filterCount = computed(() => activeFilters.value.length)
const filtered = computed(() => !!(search.value || filterCount.value))

function clearFilters() {
  search.value = ''
  triggerFilter.value = []
  adapterFilter.value = []
  botFilter.value = []
  statusFilter.value = []
}

const shown = computed(() => {
  const words = search.value.trim().toLowerCase()
  const result = flows.value.filter((flow) => {
    if (words && !`${flow.name} ${flow.description ?? ''} ${flow.triggers.map((item) => item.summary).join(' ')}`.toLowerCase().includes(words)) return false
    if (triggerFilter.value.length && !kindsOf(flow).some((kind) => triggerFilter.value.includes(kind))) return false
    if (adapterFilter.value.length && !adapterFilter.value.includes(adapterOf(flow))) return false
    if (botFilter.value.length && !flow.bots.some((bot) => botFilter.value.includes(bot))) return false
    if (statusFilter.value.length) {
      const states: Status[] = [flow.enabled ? 'enabled' : 'disabled', ...(flow.errors ? ['errors' as const] : [])]
      if (!statusFilter.value.some((status) => states.includes(status as Status))) return false
    }
    return true
  })
  const compare: Record<Sort, (a: FlowSummary, b: FlowSummary) => number> = {
    updated: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => b.createdAt - a.createdAt,
    name: (a, b) => a.name.localeCompare(b.name),
  }
  return result.sort(compare[sort.value])
})

/** When a flow was last edited, as today / yesterday / this week / earlier. */
function recency(time: number) {
  const day = 86_400_000
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const start = today.getTime()
  if (time >= start) return 'today'
  if (time >= start - day) return 'yesterday'
  if (time >= start - 6 * day) return 'week'
  return 'earlier'
}

interface Bucket {
  key: string
  label: string
  icon?: Component
  items: FlowSummary[]
}

/** How many of the most recently edited flows the group at the top shows. */
const RECENT_COUNT = 4

const groups = computed<Bucket[]>(() => {
  // The most recently edited flows come first, whatever the grouping, so the ones being worked on are at hand.
  const recent: Bucket[] = group.value === 'recent' || shown.value.length <= RECENT_COUNT ? [] : [{
    key: '@recent',
    label: t('flows.recentlyEdited'),
    icon: TimeOutline,
    items: [...shown.value].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_COUNT),
  }]
  if (group.value === 'none') return [...recent, { key: 'all', label: t('flows.allFlows'), icon: AppsOutline, items: shown.value }]
  const buckets = new Map<string, Bucket>()
  const add = (key: string, label: string, flow: FlowSummary, bucketIcon?: Component) => {
    let bucket = buckets.get(key)
    if (!bucket) buckets.set(key, bucket = { key, label, icon: bucketIcon, items: [] })
    bucket.items.push(flow)
  }
  for (const flow of shown.value) {
    if (group.value === 'trigger') {
      const kinds = kindsOf(flow)
      if (!kinds.length) add('none', t('flows.kind.none'), flow, AppsOutline)
      // A flow with several kinds of trigger shows in each of their groups.
      for (const kind of kinds) add(kind, t(`flows.kind.${kind}`), flow, kindIcon(kind))
    } else if (group.value === 'adapter') {
      const adapter = adapterOf(flow)
      add(adapter, adapterLabel(adapter || undefined), flow, ExtensionPuzzleOutline)
    } else if (group.value === 'bot') {
      if (!flow.bots.length) add('', t('flows.runsOnNone'), flow, ChatbubblesOutline)
      for (const bot of flow.bots) add(bot, botName(bot), flow, ChatbubblesOutline)
    } else {
      const key = recency(flow.updatedAt)
      add(key, t(`flows.recent.${key}`), flow, TimeOutline)
    }
  }
  const order = group.value === 'trigger' ? [...triggerKinds, 'none'] : group.value === 'recent' ? ['today', 'yesterday', 'week', 'earlier'] : undefined
  const result = [...buckets.values()]
  if (order) result.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  else result.sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : a.label.localeCompare(b.label)))
  return [...recent, ...result]
})

const collapsed = ref(new Set<string>())
function toggleGroup(key: string) {
  const next = new Set(collapsed.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsed.value = next
}

const triggerText = (flow: FlowSummary) => flow.triggers.filter((item) => !item.skip).map((item) => item.summary).filter(Boolean).join('、')

const columns = computed<DataTableColumns<FlowSummary>>(() => [
  {
    title: t('common.name'),
    key: 'name',
    ellipsis: { tooltip: true },
    render: (flow) => h('div', { class: 'name-cell' }, [
      h('strong', null, flow.name),
      ...(flow.description ? [h('span', { class: 'sub' }, flow.description)] : []),
    ]),
  },
  { title: t('flows.colTriggers'), key: 'triggers', ellipsis: { tooltip: true }, render: (flow) => triggerText(flow) || '—' },
  { title: t('flows.adapter'), key: 'adapter', width: 130, render: (flow) => adapterLabel(adapterOf(flow) || undefined) },
  {
    title: t('flows.bots'),
    key: 'bots',
    render: (flow) => (flow.bots.length ? flow.bots.map(botName).join('、') : h('span', { class: 'sub' }, t('flows.runsOnNone'))),
  },
  { title: t('flows.colNodes'), key: 'nodes', width: 70, align: 'right' },
  { title: t('flows.colIssues'), key: 'issues', width: 140, render: (flow) => h('div', { class: 'tag-row' }, tagsOf(flow)) },
  { title: t('flows.colUpdated'), key: 'updatedAt', width: 130, render: (flow) => formatTime(flow.updatedAt) },
  {
    title: t('flows.colEnabled'),
    key: 'enabled',
    width: 80,
    render: (flow) => h(NSwitch, { size: 'small', value: flow.enabled, onClick: (event: Event) => event.stopPropagation(), 'onUpdate:value': (value: boolean) => setEnabled(flow, value) }),
  },
  {
    title: '',
    key: 'actions',
    width: 50,
    // A plugin's flows are removed through the plugin.
    render: (flow) => (ownedByPlugin(flow) ? null : h(IconAction, { icon: TrashOutline, label: t('common.delete'), type: 'error', onClick: () => remove(flow) })),
  },
])

// Display names of plugins, for flows that a plugin made.
const pluginNames = ref(new Map<string, string>())
onMounted(() => {
  call<{ package: string; manifest?: { displayName?: any } }[]>('plugins.list')
    .then((list) => (pluginNames.value = new Map(list.map((entry) => [entry.package, localize(entry.manifest?.displayName, locale.value) || entry.package]))))
    .catch(() => {})
})

const ownedByPlugin = (flow: FlowSummary) => flow.source?.kind === 'plugin'

/** Where a flow came from, as a tag: a plugin's flows link to that plugin. */
function sourceTag(flow: FlowSummary) {
  const source = flow.source
  if (source?.kind === 'plugin') {
    const name = pluginNames.value.get(source.plugin ?? '') ?? source.plugin
    return h(NTag, {
      size: 'small',
      bordered: false,
      type: 'success',
      class: 'source-tag',
      title: t('flows.sourcePluginHint'),
      onClick: (event: Event) => {
        event.stopPropagation()
        router.push({ path: '/plugins', query: { highlight: source.plugin } })
      },
    }, { default: () => t('flows.sourcePlugin', { name }), icon: () => h(NIcon, null, { default: () => h(ExtensionPuzzleOutline) }) })
  }
  if (source?.kind === 'agent') return h(NTag, { size: 'small', bordered: false }, { default: () => t('flows.sourceAgent'), icon: () => h(NIcon, null, { default: () => h(SparklesOutline) }) })
  return undefined
}

/** Status tags shown on cards and in the list. */
function tagsOf(flow: FlowSummary) {
  const tags = []
  const source = sourceTag(flow)
  if (source) tags.push(source)
  if (!flow.enabled) tags.push(h(NTag, { size: 'small', bordered: false }, () => t('flows.disabledTag')))
  if (flow.blocked) tags.push(h(NTag, { size: 'small', bordered: false, type: 'warning' }, () => (flow.blocked === 'all' ? t('flows.blockedTag') : t('flows.partlyBlocked'))))
  if (flow.errors) tags.push(h(NTag, { size: 'small', bordered: false, type: 'error' }, () => t('flows.errorCount', flow.errors)))
  else if (flow.warnings) tags.push(h(NTag, { size: 'small', bordered: false, type: 'warning' }, () => t('flows.warningCount', flow.warnings)))
  return tags
}

const rowProps = (flow: FlowSummary) => ({ class: ['flow-row', { off: !flow.enabled }], onClick: () => router.push(`/flows/${flow.id}`) })

// ---- creating, switching and deleting ----

const showCreate = ref(false)
const creating = ref(false)
const form = ref({ name: '', template: 'keyword', bots: [] as string[] })

function openCreate() {
  form.value = { name: '', template: 'keyword', bots: [] }
  showCreate.value = true
}

async function create() {
  if (!form.value.name.trim()) return
  const template = flowTemplates.find((item) => item.id === form.value.template) ?? flowTemplates[0]
  creating.value = true
  try {
    const flow = await call<FlowDoc>('flows.create', {
      name: form.value.name.trim(),
      bots: form.value.bots,
      nodes: template.nodes,
      edges: template.edges,
    })
    showCreate.value = false
    router.push(`/flows/${flow.id}`)
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    creating.value = false
  }
}

async function setEnabled(flow: FlowSummary, value: boolean) {
  try {
    await call('flows.update', { id: flow.id, enabled: value })
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  }
}

function remove(flow: FlowSummary) {
  dialog.warning({
    title: t('common.confirmDelete', { name: flow.name }),
    content: t('flows.deleteHint'),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await call('flows.delete', { id: flow.id })
      message.success(t('common.deleted'))
      await refresh()
    },
  })
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>{{ t('nav.flows') }}</h1>
        <p class="page-lead">{{ t('flows.lead') }}</p>
      </div>
      <div class="header-actions">
        <NRadioGroup v-if="flows.length" v-model:value="view" class="views">
          <NRadioButton value="cards" :title="t('flows.viewCards')" :aria-label="t('flows.viewCards')"><NIcon class="view-icon"><AppsOutline /></NIcon></NRadioButton>
          <NRadioButton value="list" :title="t('flows.viewList')" :aria-label="t('flows.viewList')"><NIcon class="view-icon"><ListOutline /></NIcon></NRadioButton>
        </NRadioGroup>
        <NButton type="primary" data-agent-target="flows.add" @click="openCreate">
          <template #icon><NIcon><AddOutline /></NIcon></template>
          {{ t('flows.add') }}
        </NButton>
      </div>
    </div>

    <div v-if="flows.length" class="toolbar" data-agent-target="flows.filters">
      <NInput v-model:value="search" clearable :placeholder="t('flows.searchPlaceholder')" class="search">
        <template #prefix><NIcon><SearchOutline /></NIcon></template>
      </NInput>
      <NPopover trigger="click" placement="bottom-start" :show-arrow="false" class="filter-popover">
        <template #trigger>
          <NBadge :value="filterCount" :show="filterCount > 0" :offset="[-4, 4]">
            <NButton :type="filterCount ? 'primary' : 'default'" :secondary="!!filterCount">
              <template #icon><NIcon><FilterOutline /></NIcon></template>
              {{ t('flows.filter') }}
            </NButton>
          </NBadge>
        </template>
        <div class="filter-panel">
          <section v-for="section in filterSections" :key="section.key" class="filter-section">
            <div class="filter-title">{{ section.title }}</div>
            <div class="chips">
              <button
                v-for="item in section.items"
                :key="item.value"
                type="button"
                class="chip"
                :class="{ on: section.model.value.includes(item.value) }"
                @click="toggleFilter(section.model, item.value)"
              >
                <NIcon :size="14"><component :is="item.icon" /></NIcon>
                {{ item.label }}
              </button>
              <span v-if="!section.items.length" class="sub">{{ t('flows.filterNone') }}</span>
            </div>
          </section>
          <div v-if="filterCount" class="filter-foot">
            <NButton size="small" quaternary @click="clearFilters">
              <template #icon><NIcon><CloseCircleOutline /></NIcon></template>
              {{ t('flows.clearFilters') }}
            </NButton>
          </div>
        </div>
      </NPopover>
      <NTag v-for="item in activeFilters" :key="item.key" closable size="small" :bordered="false" type="info" class="active-filter" @close="item.remove()">
        <template #icon><NIcon><component :is="item.icon" /></NIcon></template>
        {{ item.label }}
      </NTag>
      <span class="spacer" />
      <NSelect v-model:value="group" :options="groupOptions" :render-label="renderLabel" class="small-select" :title="t('flows.groupTitle')">
        <template #arrow><NIcon><LayersOutline /></NIcon></template>
      </NSelect>
      <NSelect v-model:value="sort" :options="sortOptions" class="small-select" :title="t('flows.sortTitle')">
        <template #arrow><NIcon><SwapVerticalOutline /></NIcon></template>
      </NSelect>
    </div>

    <template v-if="shown.length">
      <section v-for="bucket in groups" :key="bucket.key" class="bucket">
        <button v-if="group !== 'none' || groups.length > 1" type="button" class="bucket-head" @click="toggleGroup(bucket.key)">
          <span class="caret" :class="{ closed: collapsed.has(bucket.key) }">▾</span>
          <NIcon v-if="bucket.icon" :size="16" class="bucket-icon"><component :is="bucket.icon" /></NIcon>
          <strong>{{ bucket.label }}</strong>
          <span class="sub">{{ bucket.items.length }}</span>
        </button>
        <template v-if="!collapsed.has(bucket.key)">
          <NGrid v-if="view === 'cards'" cols="1 640:2 1000:3" :x-gap="16" :y-gap="16">
            <NGridItem v-for="flow in bucket.items" :key="flow.id">
              <NCard hoverable class="flow-card" :class="{ off: !flow.enabled }" @click="router.push(`/flows/${flow.id}`)">
                <div class="flow-head">
                  <div class="flow-avatar"><NIcon size="22"><GitNetworkOutline /></NIcon></div>
                  <div class="flow-title">
                    <strong>{{ flow.name }}</strong>
                    <span class="sub">{{ t('flows.nodeCount', flow.nodes) }} · {{ formatTime(flow.updatedAt) }}</span>
                  </div>
                  <NSwitch size="small" :value="flow.enabled" :title="flow.enabled ? t('flows.enabledHint') : t('flows.disabledHint')" @click.stop @update:value="(value: boolean) => setEnabled(flow, value)" />
                  <IconAction v-if="!ownedByPlugin(flow)" :icon="TrashOutline" :label="t('common.delete')" type="error" @click="remove(flow)" />
                </div>
                <p v-if="flow.description" class="flow-desc">{{ flow.description }}</p>
                <p v-if="triggerText(flow)" class="flow-triggers">{{ triggerText(flow) }}</p>
                <div class="flow-tags">
                  <component :is="tag" v-for="(tag, index) in tagsOf(flow)" :key="index" />
                  <NTag v-for="bot in flow.bots" :key="bot" size="small" :bordered="false" type="info">{{ botName(bot) }}</NTag>
                  <span v-if="!flow.bots.length" class="sub">{{ t('flows.runsOnNone') }}</span>
                </div>
              </NCard>
            </NGridItem>
          </NGrid>
          <NCard v-else size="small" class="table-card">
            <NDataTable :columns="columns" :data="bucket.items" :row-key="(flow: FlowSummary) => flow.id" :row-props="rowProps" size="small" :bordered="false" :scroll-x="980" />
          </NCard>
        </template>
      </section>
    </template>

    <NCard v-else-if="loaded && flows.length">
      <NEmpty :description="t('flows.noMatch')">
        <template #extra>
          <NButton v-if="filtered" @click="clearFilters">{{ t('flows.clearFilters') }}</NButton>
        </template>
      </NEmpty>
    </NCard>

    <NCard v-else-if="loaded">
      <NEmpty :description="t('flows.empty')">
        <template #extra>
          <NButton type="primary" @click="openCreate">{{ t('flows.add') }}</NButton>
        </template>
      </NEmpty>
    </NCard>

    <NModal v-model:show="showCreate" preset="card" :title="t('flows.add')" class="create-modal" :style="{ width: 'min(560px, calc(100vw - 32px))' }">
      <NForm label-placement="top" @submit.prevent="create">
        <NFormItem :label="t('common.name')">
          <NInput v-model:value="form.name" :placeholder="t('flows.namePlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('flows.template')">
          <div class="templates">
            <button
              v-for="template in flowTemplates"
              :key="template.id"
              type="button"
              class="template"
              :class="{ active: form.template === template.id }"
              @click="form.template = template.id"
            >
              <strong>{{ t(`flows.templates.${template.id}.title`) }}</strong>
              <span class="sub">{{ t(`flows.templates.${template.id}.description`) }}</span>
            </button>
          </div>
        </NFormItem>
        <NFormItem :label="t('flows.bots')" :feedback="t('flows.botsHint')">
          <NSelect v-model:value="form.bots" multiple :options="botOptions" :placeholder="t('flows.runsOnNone')" />
        </NFormItem>
      </NForm>
      <template #footer>
        <div class="modal-actions">
          <NButton @click="showCreate = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="creating" :disabled="!form.name.trim()" @click="create">{{ t('common.create') }}</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.search {
  width: 240px;
}

.small-select {
  width: 140px;
}

.active-filter {
  max-width: 180px;
}

.filter-panel {
  width: min(420px, calc(100vw - 48px));
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 2px;
}

.filter-title {
  font-size: 12px;
  opacity: 0.65;
  margin-bottom: 6px;
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
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid rgba(127, 127, 127, 0.3);
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 0.15s, border-color 0.15s;
}

.chip:hover {
  background: var(--row-hover);
}

.chip.on {
  border-color: #2080f0;
  background: rgba(32, 128, 240, 0.12);
  color: #2080f0;
}

.filter-foot {
  display: flex;
  justify-content: flex-end;
}

.bucket-icon {
  opacity: 0.7;
}

.spacer {
  flex: 1;
}

.view-icon {
  vertical-align: -2px;
}

.bucket + .bucket {
  margin-top: 20px;
}

.bucket-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.caret {
  display: inline-block;
  transition: transform 0.15s;
}

.caret.closed {
  transform: rotate(-90deg);
}

.table-card :deep(.flow-row) {
  cursor: pointer;
}

.table-card :deep(.flow-row.off) {
  opacity: 0.6;
}

.table-card :deep(.name-cell) {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.table-card :deep(.name-cell .sub) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.table-card :deep(.tag-row) {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

:deep(.source-tag) {
  cursor: pointer;
}

.flow-triggers {
  margin: 8px 0 0;
  font-size: 12px;
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flow-card.off {
  opacity: 0.6;
}

.flow-card {
  cursor: pointer;
}

.flow-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.flow-avatar {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(32, 128, 240, 0.12);
  color: #2080f0;
  flex: none;
}

.flow-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.flow-title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub,
.table-card :deep(.sub) {
  font-size: 12px;
  opacity: 0.6;
}

.flow-desc {
  margin: 12px 0 0;
  opacity: 0.75;
  font-size: 13px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.flow-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
}

.templates {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  width: 100%;
}

.template {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  font: inherit;
  color: inherit;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(127, 127, 127, 0.3);
  background: transparent;
  cursor: pointer;
}

.template.active {
  border-color: #5b6bc0;
  box-shadow: 0 0 0 2px rgba(91, 107, 192, 0.3);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
