<script setup lang="ts">
import {
  AddOutline, AlertCircleOutline, AppsOutline, ChatbubblesOutline, CloseCircleOutline, ExtensionPuzzleOutline, FilterOutline, GitNetworkOutline,
  LayersOutline, ListOutline, NotificationsOutline, SearchOutline, SparklesOutline, SwapVerticalOutline, TimeOutline, TrashOutline,
} from '@vicons/ionicons5'
import {
  type DataTableColumns, NBadge, NButton, NCard, NDataTable, NEmpty, NForm, NFormItem, NIcon, NInput, NModal, NPopover,
  NRadioButton, NRadioGroup, NSelect, type SelectOption, NSwitch, NTag, useDialog, useMessage,
} from 'naive-ui'
import { type Component, computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { call, on } from '../api'
import { avatarColor, initial } from '../botAvatar'
import EmptyState from '../components/EmptyState.vue'
import PageHeader from '../components/PageHeader.vue'
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
type State = 'all' | 'on' | 'problem' | 'off'

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
const states: State[] = ['all', 'on', 'problem', 'off']
const state = ref<State>(states.includes(route.query.status as State) ? route.query.status as State : 'all')

watch([search, view, group, sort, triggerFilter, adapterFilter, botFilter, state], () => {
  const query: Record<string, string> = {}
  if (search.value) query.q = search.value
  if (view.value !== 'cards') query.view = view.value
  if (group.value !== DEFAULT_GROUP) query.group = group.value
  if (sort.value !== 'updated') query.sort = sort.value
  if (triggerFilter.value.length) query.trigger = triggerFilter.value.join(',')
  if (adapterFilter.value.length) query.adapter = adapterFilter.value.join(',')
  if (botFilter.value.length) query.bot = botFilter.value.join(',')
  if (state.value !== 'all') query.status = state.value
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
])

function toggleFilter(model: { value: string[] }, value: string) {
  model.value = model.value.includes(value) ? model.value.filter((item) => item !== value) : [...model.value, value]
}

/** Every active filter as a removable tag. */
const activeFilters = computed(() => filterSections.value.flatMap((section) => section.items
  .filter((item) => section.model.value.includes(item.value))
  .map((item) => ({ key: `${section.key}:${item.value}`, label: item.label, icon: item.icon, remove: () => toggleFilter(section.model, item.value) }))))
const filterCount = computed(() => activeFilters.value.length)
const filtered = computed(() => !!(search.value || filterCount.value || state.value !== 'all'))

function clearFilters() {
  search.value = ''
  triggerFilter.value = []
  adapterFilter.value = []
  botFilter.value = []
  state.value = 'all'
}

// ---- one status per flow, as on the bot cards ----
// An enabled flow that cannot run (errors, or every trigger shadowed) needs attention; warnings do not.

function stateOf(flow: FlowSummary): Exclude<State, 'all'> {
  if (!flow.enabled) return 'off'
  return flow.errors || flow.blocked === 'all' ? 'problem' : 'on'
}

const stateClass = { on: 'ok', problem: 'bad', off: 'idle' } as const

const counts = computed(() => {
  const result = { all: flows.value.length, on: 0, problem: 0, off: 0 }
  for (const flow of flows.value) result[stateOf(flow)]++
  return result
})

const stateChips = computed(() => states
  .filter((key) => key === 'all' || counts.value[key] > 0 || state.value === key)
  .map((key) => ({ key, dot: key === 'all' ? '' : stateClass[key] })))

/** What is wrong with a flow, in one line, for its card. */
function issueOf(flow: FlowSummary) {
  if (flow.errors) return { tone: 'bad', text: t('flows.errorCount', flow.errors) }
  if (flow.blocked) return { tone: 'warn', text: flow.blocked === 'all' ? t('flows.blockedTag') : t('flows.partlyBlocked') }
  if (flow.warnings) return { tone: 'warn', text: t('flows.warningCount', flow.warnings) }
  return undefined
}

/** How many triggers a card shows before "+N". */
const TRIGGER_COUNT = 3
const activeTriggers = (flow: FlowSummary) => flow.triggers.filter((item) => !item.skip)

const open = (flow: FlowSummary) => router.push(`/flows/${flow.id}`)

const shown = computed(() => {
  const words = search.value.trim().toLowerCase()
  const result = flows.value.filter((flow) => {
    if (words && !`${flow.name} ${flow.description ?? ''} ${flow.triggers.map((item) => item.summary).join(' ')}`.toLowerCase().includes(words)) return false
    if (triggerFilter.value.length && !kindsOf(flow).some((kind) => triggerFilter.value.includes(kind))) return false
    if (adapterFilter.value.length && !adapterFilter.value.includes(adapterOf(flow))) return false
    if (botFilter.value.length && !flow.bots.some((bot) => botFilter.value.includes(bot))) return false
    if (state.value !== 'all' && stateOf(flow) !== state.value) return false
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
  /** The bot a group is for, shown with its avatar. */
  bot?: string
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
  const add = (key: string, label: string, flow: FlowSummary, bucketIcon?: Component, bot?: string) => {
    let bucket = buckets.get(key)
    if (!bucket) buckets.set(key, bucket = { key, label, icon: bucketIcon, bot, items: [] })
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
      for (const bot of flow.bots) add(bot, botName(bot), flow, undefined, bot)
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
  {
    title: t('flows.colIssues'),
    key: 'issues',
    width: 220,
    render: (flow) => h('div', { class: 'tag-row' }, [
      h('span', { class: ['pill', stateClass[stateOf(flow)]] }, [h('span', { class: 'dot' }), t(`flows.state.${stateOf(flow)}`)]),
      ...tagsOf(flow),
    ]),
  },
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
const pluginName = (flow: FlowSummary) => pluginNames.value.get(flow.source?.plugin ?? '') ?? flow.source?.plugin
const openPlugin = (flow: FlowSummary) => router.push({ path: '/plugins', query: { highlight: flow.source?.plugin } })

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
      title: `${t('flows.sourcePlugin', { name })}\n${t('flows.sourcePluginHint')}`,
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
  if (flow.blocked) tags.push(h(NTag, { size: 'small', bordered: false, type: 'warning' }, () => (flow.blocked === 'all' ? t('flows.blockedTag') : t('flows.partlyBlocked'))))
  if (flow.errors) tags.push(h(NTag, { size: 'small', bordered: false, type: 'error' }, () => t('flows.errorCount', flow.errors)))
  else if (flow.warnings) tags.push(h(NTag, { size: 'small', bordered: false, type: 'warning' }, () => t('flows.warningCount', flow.warnings)))
  return tags
}

const rowProps = (flow: FlowSummary) => ({ class: ['flow-row', { off: !flow.enabled }], onClick: () => open(flow) })

// ---- creating, switching and deleting ----

const showCreate = ref(false)
const creating = ref(false)
const form = ref({ name: '', template: 'keyword', bots: [] as string[] })

function openCreate() {
  form.value = { name: '', template: 'keyword', bots: [] }
  showCreate.value = true
}

// /flows?new=1 (from search) opens the new-flow dialog.
if (route.query.new) {
  openCreate()
  router.replace({ query: { ...route.query, new: undefined } })
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
    <PageHeader :title="t('nav.flows')" :lead="t('flows.lead')">
      <NRadioGroup v-if="flows.length" v-model:value="view" class="views">
        <NRadioButton value="cards" :title="t('flows.viewCards')" :aria-label="t('flows.viewCards')"><NIcon class="view-icon"><AppsOutline /></NIcon></NRadioButton>
        <NRadioButton value="list" :title="t('flows.viewList')" :aria-label="t('flows.viewList')"><NIcon class="view-icon"><ListOutline /></NIcon></NRadioButton>
      </NRadioGroup>
      <NButton type="primary" data-agent-target="flows.add" @click="openCreate">
        <template #icon><NIcon><AddOutline /></NIcon></template>
        {{ t('flows.add') }}
      </NButton>
    </PageHeader>

    <div v-if="flows.length" class="toolbar" data-agent-target="flows.filters">
      <NInput v-model:value="search" clearable :placeholder="t('flows.searchPlaceholder')" class="search">
        <template #prefix><NIcon><SearchOutline /></NIcon></template>
      </NInput>
      <div class="chips" role="radiogroup" :aria-label="t('flows.filterLabel')">
        <button
          v-for="item in stateChips"
          :key="item.key"
          type="button"
          role="radio"
          class="chip"
          :class="{ on: state === item.key }"
          :aria-checked="state === item.key"
          @click="state = item.key"
        >
          <span v-if="item.dot" class="dot" :class="item.dot" />
          {{ t(`flows.state.${item.key}`) }}
          <span class="count">{{ counts[item.key] }}</span>
        </button>
      </div>
      <NPopover trigger="click" placement="bottom-start" :show-arrow="false">
        <template #trigger>
          <NBadge :value="filterCount" :show="filterCount > 0" :offset="[-4, 4]">
            <NButton :type="filterCount ? 'primary' : 'default'" :secondary="!!filterCount">
              <template #icon><NIcon><FilterOutline /></NIcon></template>
              {{ t('flows.filter') }}
            </NButton>
          </NBadge>
        </template>
        <div class="filter-panel">
          <section v-for="section in filterSections" :key="section.key">
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
      <section v-for="(bucket, index) in groups" :key="bucket.key" class="bucket">
        <button
          v-if="group !== 'none' || groups.length > 1"
          type="button"
          class="bucket-head"
          :aria-expanded="!collapsed.has(bucket.key)"
          @click="toggleGroup(bucket.key)"
        >
          <span class="caret" :class="{ closed: collapsed.has(bucket.key) }">▾</span>
          <span v-if="bucket.bot" class="mini-avatar" :style="{ background: avatarColor(bucket.bot) }" aria-hidden="true">{{ initial(bucket.label) }}</span>
          <NIcon v-else-if="bucket.icon" :size="16" class="bucket-icon"><component :is="bucket.icon" /></NIcon>
          <strong>{{ bucket.label }}</strong>
          <span class="count">{{ bucket.items.length }}</span>
        </button>
        <template v-if="!collapsed.has(bucket.key)">
          <div v-if="view === 'cards'" class="flow-grid">
            <article
              v-for="flow in bucket.items"
              :key="flow.id"
              class="flow"
              :class="{ off: !flow.enabled }"
              tabindex="0"
              :aria-label="flow.name"
              @click="open(flow)"
              @keyup.enter.self="open(flow)"
            >
              <div class="flow-head">
                <div class="flow-icon" aria-hidden="true"><NIcon :size="20"><GitNetworkOutline /></NIcon></div>
                <div class="flow-title">
                  <strong class="name" :title="flow.name">{{ flow.name }}</strong>
                  <span class="meta">{{ t('flows.nodeCount', flow.nodes) }} · {{ t('flows.editedAt', { time: formatTime(flow.updatedAt) }) }}</span>
                </div>
                <span class="pill" :class="stateClass[stateOf(flow)]"><span class="dot" />{{ t(`flows.state.${stateOf(flow)}`) }}</span>
              </div>

              <div class="flow-body">
                <p v-if="flow.description" class="desc" :title="flow.description">{{ flow.description }}</p>
                <div v-if="issueOf(flow)" class="note" :class="issueOf(flow)!.tone">
                  <NIcon :size="15"><AlertCircleOutline /></NIcon>
                  <span>{{ issueOf(flow)!.text }}</span>
                </div>
                <div class="triggers">
                  <span v-for="trigger in activeTriggers(flow).slice(0, TRIGGER_COUNT)" :key="trigger.id" class="trigger" :title="trigger.summary">
                    <NIcon :size="13"><component :is="kindIcon(kindOf(trigger))" /></NIcon>
                    <span>{{ trigger.summary || t(`flows.kind.${kindOf(trigger)}`) }}</span>
                  </span>
                  <span v-if="activeTriggers(flow).length > TRIGGER_COUNT" class="trigger more">{{ t('flows.moreTriggers', { count: activeTriggers(flow).length - TRIGGER_COUNT }) }}</span>
                  <span v-if="!activeTriggers(flow).length" class="none">{{ t('flows.kind.none') }}</span>
                </div>
              </div>

              <div class="flow-foot" @click.stop>
                <div class="runs-on" :title="flow.bots.map(botName).join('、')">
                  <template v-if="flow.bots.length">
                    <span class="avatars" aria-hidden="true">
                      <span v-for="bot in flow.bots.slice(0, 3)" :key="bot" class="mini-avatar" :style="{ background: avatarColor(bot) }">{{ initial(botName(bot)) }}</span>
                    </span>
                    <span class="bot-names">{{ flow.bots.map(botName).join('、') }}</span>
                  </template>
                  <span v-else class="none">{{ t('flows.runsOnNone') }}</span>
                </div>
                <button v-if="ownedByPlugin(flow)" type="button" class="source" :title="`${t('flows.sourcePlugin', { name: pluginName(flow) })}\n${t('flows.sourcePluginHint')}`" @click="openPlugin(flow)">
                  <NIcon :size="14"><ExtensionPuzzleOutline /></NIcon>{{ t('flows.sourcePluginShort') }}
                </button>
                <span v-else-if="flow.source?.kind === 'agent'" class="source" :title="t('flows.sourceAgent')">
                  <NIcon :size="14"><SparklesOutline /></NIcon>{{ t('flows.sourceAgentShort') }}
                </span>
                <NSwitch size="small" :value="flow.enabled" :title="flow.enabled ? t('flows.enabledHint') : t('flows.disabledHint')" @update:value="(value: boolean) => setEnabled(flow, value)" />
                <IconAction v-if="!ownedByPlugin(flow)" :icon="TrashOutline" :label="t('common.delete')" type="error" @click="remove(flow)" />
              </div>
            </article>

            <button v-if="!filtered && index === groups.length - 1" type="button" class="add-card" @click="openCreate">
              <span class="plus"><NIcon :size="20"><AddOutline /></NIcon></span>
              <strong>{{ t('flows.add') }}</strong>
              <span class="hint">{{ t('flows.addHint') }}</span>
            </button>
          </div>
          <NCard v-else size="small" class="table-card">
            <NDataTable :columns="columns" :data="bucket.items" :row-key="(flow: FlowSummary) => flow.id" :row-props="rowProps" size="small" :bordered="false" :scroll-x="980" />
          </NCard>
        </template>
      </section>
    </template>

    <NEmpty v-else-if="loaded && flows.length" :description="t('flows.noMatch')" class="no-match">
      <template #extra>
        <NButton @click="clearFilters">{{ t('flows.clearFilters') }}</NButton>
      </template>
    </NEmpty>

    <EmptyState v-else-if="loaded" :icon="GitNetworkOutline" :title="t('flows.emptyTitle')" :hint="t('flows.empty')">
      <NButton type="primary" @click="openCreate">{{ t('flows.add') }}</NButton>
    </EmptyState>

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

.search {
  width: 220px;
}

.small-select {
  width: 124px;
}

.active-filter {
  max-width: 180px;
}

.spacer {
  flex: 1;
}

.view-icon {
  vertical-align: -2px;
}

/* ---- chips: the status row, and the toggles in the filter panel ---- */

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
.flow:focus-visible,
.add-card:focus-visible,
.bucket-head:focus-visible,
.source:focus-visible {
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
.dot.bad { background: var(--bad); }

.filter-panel {
  width: min(420px, calc(100vw - 48px));
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 2px;
}

.filter-panel .chip {
  height: 26px;
  padding: 0 10px;
  gap: 5px;
}

.filter-title {
  font-size: 12px;
  color: var(--fg3);
  margin-bottom: 6px;
}

.filter-foot {
  display: flex;
  justify-content: flex-end;
}

/* ---- groups ---- */

.bucket + .bucket {
  margin-top: 24px;
}

.bucket-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--fg);
  font: inherit;
  font-size: 13.5px;
  cursor: pointer;
}

.caret {
  display: inline-block;
  color: var(--fg3);
  transition: transform 0.15s;
}

.caret.closed {
  transform: rotate(-90deg);
}

.bucket-icon {
  color: var(--fg3);
}

.mini-avatar {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex: none;
  color: #fff;
  font-size: 11px;
  font-weight: 650;
}

/* ---- cards ---- */

.flow-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

.flow {
  display: grid;
  grid-template-rows: auto 1fr auto;
  min-height: 188px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.flow:hover {
  border-color: var(--primary);
  box-shadow: var(--shadow);
}

.flow.off {
  background: color-mix(in srgb, var(--s1) 70%, var(--bg));
}

.flow-head {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 16px 16px 10px;
}

.flow-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: var(--primary-soft);
  color: var(--primary);
}

.off .flow-icon {
  background: var(--s2);
  color: var(--fg3);
}

.flow-title {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.name,
.meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name {
  font-size: 15px;
}

.meta {
  font-size: 12.5px;
  color: var(--fg3);
}

.pill,
.table-card :deep(.pill) {
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

.pill .dot,
.table-card :deep(.pill .dot) {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: currentColor;
}

.pill.ok,
.table-card :deep(.pill.ok) { color: var(--ok); background: var(--ok-soft); }
.pill.bad,
.table-card :deep(.pill.bad) { color: var(--bad); background: var(--bad-soft); }
.pill.idle,
.table-card :deep(.pill.idle) { color: var(--fg2); background: var(--s2); }

.flow-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 0 16px 12px;
}

.desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.note {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}

.note.bad { color: var(--bad); }
.note.warn { color: var(--warn); }

/* Triggers sit at the bottom of the body, one line, so cards in a row line up. */
.triggers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 24px;
  margin-top: auto;
  overflow: hidden;
}

.trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  background: var(--s2);
  color: var(--fg2);
  font-size: 12px;
}

.trigger > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trigger.more {
  color: var(--fg3);
}

.none {
  font-size: 12.5px;
  color: var(--fg3);
}

.flow-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  height: 44px;
  padding: 0 10px 0 16px;
  border-top: 1px solid var(--line);
  font-size: 12.5px;
  color: var(--fg2);
  cursor: default;
}

.runs-on {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.avatars {
  display: flex;
  flex: none;
}

/* Overlapping avatars, each ringed with the card colour. */
.avatars .mini-avatar {
  box-shadow: 0 0 0 2px var(--s1);
}

.avatars .mini-avatar + .mini-avatar {
  margin-left: -6px;
}

.bot-names {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 0;
  border: 0;
  background: none;
  color: var(--fg3);
  font: inherit;
  font-size: 12px;
}

button.source {
  cursor: pointer;
}

button.source:hover {
  color: var(--primary);
}

.add-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 188px;
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

/* ---- list ---- */

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
  min-width: 0;
}

/* A long tag (a plugin's package name) is cut short inside its column; the title holds the whole text. */
.table-card :deep(.tag-row .n-tag) {
  max-width: 100%;
}

.table-card :deep(.tag-row .n-tag__content) {
  overflow: hidden;
  text-overflow: ellipsis;
}

:deep(.source-tag) {
  cursor: pointer;
}

.sub,
.table-card :deep(.sub) {
  font-size: 12px;
  color: var(--fg3);
}

/* ---- create ---- */

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
  border: 1px solid var(--line);
  background: transparent;
  cursor: pointer;
}

.template.active {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
