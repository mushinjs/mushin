<script setup lang="ts">
import { Button, Drawer, Input, Modal, Spin, Toggle, Tooltip, useConfirm, useToast } from '@mushinjs/ui'
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { call, on } from '../api'
import AdapterIcon from '../components/AdapterIcon.vue'
import IconAction from '../components/IconAction.vue'
import PageHeader from '../components/PageHeader.vue'
import PluginPanel, { type Dependent } from '../components/plugins/PluginPanel.vue'
import UpdateBanner from '../components/updates/UpdateBanner.vue'
import UpdateDialog from '../components/updates/UpdateDialog.vue'
import InstallDialog from '../components/market/InstallDialog.vue'
import MarketGrid from '../components/market/MarketGrid.vue'
import { loadMarket, marketEntry, type MarketItem } from '../market'
import { configPreview } from '../plugins/config'
import { type GroupKey, groupOf, groupPlugins, relationsOf, toggleImpact } from '../plugins/groups'
import { GROUP_ICONS, PANEL_SECTIONS, type PanelSection, type PluginItem } from '../plugins/item'
import { prefs } from '../prefs'
import { useDataStore } from '../stores/data'
import type { AppPlugin, CatalogEntry, DependencyPlan, FlowSummary, PluginDependencies, PluginProvides, ProjectChatPlugin } from '../types'
import { pluginUpdate, updates } from '../updates'
import { localize } from '../utils'

const { t, locale } = useI18n()
const message = useToast()
const dialog = useConfirm()
const route = useRoute()
const router = useRouter()
const data = useDataStore()

const plugins = ref<AppPlugin[]>([])
const appCatalog = ref<CatalogEntry[]>([])
const botCatalog = ref<CatalogEntry[]>([])
/** Chat plugins across the bots: a bot plugin's project switch, and the bots each chat plugin is on for. */
const chatPlugins = ref<ProjectChatPlugin[]>([])
/** What each running plugin adds, by package. */
const provides = ref<Record<string, PluginProvides>>({})
const flows = ref<FlowSummary[]>([])
const loading = ref(true)
/** The package whose switch is working. */
const busy = ref<string>()

async function refresh(rescan = false) {
  try {
    const [list, catalog, chat, provided, flowList] = await Promise.all([
      call<AppPlugin[]>('plugins.list'),
      call<CatalogEntry[]>('plugins.catalog', { refresh: rescan }),
      // Without the bots plugin there are no chat plugins to switch.
      call<ProjectChatPlugin[]>('bots.plugins.project').catch(() => [] as ProjectChatPlugin[]),
      call<Record<string, PluginProvides>>('plugins.provides').catch(() => ({})),
      call<FlowSummary[]>('flows.list').catch(() => [] as FlowSummary[]),
    ])
    plugins.value = list
    chatPlugins.value = chat
    provides.value = provided
    flows.value = flowList
    appCatalog.value = catalog.filter((entry) => entry.manifest.kind === 'app')
    botCatalog.value = catalog.filter((entry) => entry.manifest.kind === 'bot')
  } catch (error) {
    // While Mushin.js restarts or updates it is away on purpose; the overlay says so.
    if (!updates.pending) message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  refresh()
  if (!data.loadedBots) data.refreshBots().catch(() => {})
  // The market listing gives installed plugins their README and versions; the server keeps it for hours.
  void loadMarket()
})

/** /plugins is what is installed, /plugins/market what can be. */
const tab = computed(() => (route.params.tab === 'market' ? 'market' : 'installed'))
const goTab = (next: 'installed' | 'market') => router.push({ path: next === 'market' ? '/plugins/market' : '/plugins', query: route.query })

let timer: number | undefined
const later = () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => refresh(), 150)
}
// A plugin's actions, nodes and commands come a moment after it starts.
const offs = [on('manager/changed', later), on('actions/changed', later), on('bots/changed', later), on('flows/changed', later)]
onBeforeUnmount(() => offs.forEach((off) => off()))

async function rescan() {
  loading.value = true
  await refresh(true)
  message.success(t('plugins.rescanned'))
}

// ---- the rows ----

const catalog = computed(() => [...appCatalog.value, ...botCatalog.value])
const entryOf = (pkg: string) => catalog.value.find((entry) => entry.package === pkg)
const nameOf = (pkg: string) => localize(entryOf(pkg)?.manifest.displayName ?? plugins.value.find((item) => item.package === pkg)?.manifest?.displayName, locale.value) || pkg
const chatOf = (pkg: string) => chatPlugins.value.find((item) => item.package === pkg)
const keyOf = (plugin: AppPlugin) => plugin.id || plugin.package

/** Configured entries, then installed app plugins that were never enabled (they have no entry id yet). */
const appPlugins = computed<AppPlugin[]>(() => [
  ...plugins.value,
  ...appCatalog.value
    .filter((entry) => !plugins.value.some((plugin) => plugin.package === entry.package))
    .map((entry) => ({ id: '', package: entry.package, enabled: false, config: {}, manifest: entry.manifest, version: entry.version, status: 'disabled' as const })),
])

/** Dependencies of a plugin that has no entry yet, worked out from the manifests: the server only describes entries. */
function depsOf(plugin: AppPlugin): PluginDependencies | undefined {
  if (plugin.dependencies) return plugin.dependencies
  const state = (pkg: string, range: string, optional: boolean) => {
    const installed = catalog.value.some((entry) => entry.package === pkg) || pkg === '@cordisjs/plugin-server'
    const enabled = plugins.value.some((item) => item.package === pkg && item.enabled)
    return { package: pkg, range, optional, installed, enabled, problem: !installed ? 'not-installed' as const : !enabled ? 'disabled' as const : undefined }
  }
  return {
    requires: Object.entries(plugin.manifest?.requires?.plugins ?? {}).map(([pkg, range]) => state(pkg, range, false)),
    optional: Object.entries(plugin.manifest?.optional?.plugins ?? {}).map(([pkg, range]) => state(pkg, range, true)),
  }
}

/**
 * Required plugins that keep it from running. A plugin that is off is not waiting on anything: turning it on
 * turns on what it needs, so only what is not installed (or the wrong version) counts.
 */
function missingOf(deps: PluginDependencies | undefined, enabled: boolean) {
  return (deps?.requires ?? []).filter((dep) => dep.problem && dep.problem !== 'not-app' && (enabled || dep.problem !== 'disabled'))
}

const items = computed<PluginItem[]>(() => [
  ...appPlugins.value.map((plugin): PluginItem => {
    const entry = entryOf(plugin.package)
    const deps = depsOf(plugin)
    const provided = provides.value[plugin.package]
    const missing = missingOf(deps, plugin.enabled)
    return {
      key: keyOf(plugin),
      package: plugin.package,
      kind: 'app',
      name: localize(plugin.manifest?.displayName, locale.value) || plugin.package,
      description: localize(plugin.manifest?.description, locale.value),
      category: plugin.manifest?.category,
      enabled: plugin.enabled,
      essential: !!plugin.manifest?.essential,
      problem: plugin.status === 'failed' || plugin.status === 'missing' || plugin.status === 'pending' || missing.length > 0 || deps?.mushin?.ok === false,
      addsAdapters: !!provided?.adapters.length,
      requires: (deps?.requires ?? []).map((dep) => dep.package),
      app: plugin,
      entry,
      deps,
      provides: provided,
      chat: chatOf(plugin.package),
      status: plugin.status,
      error: plugin.error,
      version: plugin.version ?? entry?.version,
      missing,
      market: marketEntry(plugin.package),
      installed: true,
    }
  }),
  ...botCatalog.value.map((entry): PluginItem => {
    const chat = chatOf(entry.package)
    const deps = depsOf({ id: '', package: entry.package, enabled: false, config: {}, manifest: entry.manifest, status: 'disabled' })
    const enabled = chat?.enabled ?? false
    const missing = missingOf(deps, enabled)
    return {
      key: entry.package,
      package: entry.package,
      kind: 'bot',
      name: localize(entry.manifest.displayName, locale.value) || entry.package,
      description: localize(entry.manifest.description, locale.value),
      category: entry.manifest.category,
      enabled,
      essential: !!chat?.essential,
      problem: missing.length > 0,
      requires: (deps?.requires ?? []).map((dep) => dep.package),
      entry,
      deps,
      provides: provides.value[entry.package],
      chat,
      version: entry.version,
      missing,
      market: marketEntry(entry.package),
      installed: true,
    }
  }),
])

const itemOf = (pkg: string) => items.value.find((item) => item.package === pkg)

/** A market package that is not installed, as a row of the panel. */
function marketItem(entry: MarketItem): PluginItem {
  return {
    key: `market:${entry.name}`,
    package: entry.name,
    kind: entry.kind,
    name: localize(entry.displayName, locale.value) || entry.name,
    description: localize(entry.description, locale.value),
    category: entry.category,
    enabled: false,
    requires: Object.keys(entry.requires?.plugins ?? {}),
    version: entry.choice.version ?? entry.version,
    missing: [],
    market: entry,
    installed: false,
  }
}
const relations = computed(() => relationsOf(items.value))
const adapterOf = (item: PluginItem) => {
  const id = item.provides?.adapters[0]
  return id ? data.adapters.find((adapter) => adapter.id === id) : undefined
}
const list = (names: string[]) => names.join(t('plugins.listSeparator'))
/** A list for a hint: the first few names, then how many more. */
const shortList = (names: string[], limit = 6) => list(names.slice(0, limit)) + (names.length > limit ? t('plugins.provides.more', { n: names.length - limit }) : '')

// ---- search, filters and groups ----

type Filter = 'all' | 'on' | 'problem' | 'off' | 'updates'
const query = ref('')
const filter = ref<Filter>('all')

/** A newer version of a third-party plugin from npm; official plugins update with Mushin.js. */
const updateOf = (item: PluginItem) => (item.package.startsWith('@mushinjs/') || item.entry?.local ? undefined : pluginUpdate(item.package)?.available ? pluginUpdate(item.package) : undefined)

// The update dialog, opened from the banner (everything) or a plugin's panel (that plugin).
const updateOpen = ref(false)
const updatePreset = ref<string[]>()
function openUpdate(preset?: string[]) {
  updatePreset.value = preset
  updateOpen.value = true
}

const counts = computed(() => ({
  all: items.value.length,
  on: items.value.filter((item) => item.enabled).length,
  problem: items.value.filter((item) => item.problem).length,
  off: items.value.filter((item) => !item.enabled).length,
  updates: items.value.filter((item) => updateOf(item)).length,
}))

const filters = computed(() => (['all', 'on', 'problem', 'off', 'updates'] as const).filter((key) => key === 'all' || counts.value[key] > 0 || filter.value === key))

function matches(item: PluginItem) {
  if (filter.value === 'on' && !item.enabled) return false
  if (filter.value === 'off' && item.enabled) return false
  if (filter.value === 'problem' && !item.problem) return false
  if (filter.value === 'updates' && !updateOf(item)) return false
  const text = query.value.trim().toLowerCase()
  return !text || [item.package, item.name, item.description].some((value) => value.toLowerCase().includes(text))
}

const narrowed = computed(() => !!query.value.trim() || filter.value !== 'all')
/** Groups opened for a moment to show a plugin (a link, a key press), without changing what the person chose. */
const revealed = ref(new Set<GroupKey>())

const groups = computed(() => groupPlugins(items.value, {
  matches,
  narrowed: narrowed.value,
  collapsed: prefs.pluginGroups,
  locale: locale.value,
}).map((group) => ({ ...group, open: group.open || revealed.value.has(group.key) })))

/** Whether the person can fold the group: not while a problem or a search holds it open. */
const foldable = (group: { key: GroupKey; problems: number }) => !narrowed.value && !group.problems

function toggleGroup(group: { key: GroupKey; open: boolean }) {
  const next = new Set(revealed.value)
  next.delete(group.key)
  revealed.value = next
  prefs.pluginGroups = { ...prefs.pluginGroups, [group.key]: group.open }
}

function reveal(pkg: string) {
  const item = itemOf(pkg)
  if (!item) return
  const key = groupOf(item)
  if (!groups.value.find((group) => group.key === key)?.open) revealed.value = new Set([...revealed.value, key])
}

/** The rows in the order shown, for moving through them with the arrow keys. */
const order = computed(() => groups.value.flatMap((group) => (group.open ? group.shown : [])))

// ---- hovering ----

/** The row under the pointer: the rows it needs and the rows that need it are marked. */
const hovered = ref<string>()
/** A row named in the details panel under the pointer, or a link's target, made to stand out. */
const pinged = ref<string>()

function markOf(item: PluginItem) {
  if (!hovered.value || hovered.value === item.package) return
  const relation = relations.value.get(hovered.value)
  if (relation?.requires.has(item.package)) return 'needed'
  if (relation?.dependents.has(item.package)) return 'needs'
}

/** /plugins?highlight=<package> scrolls to that plugin and makes it stand out for a moment. */
watch(() => [route.query.highlight, items.value.length] as const, async ([target]) => {
  if (typeof target !== 'string' || !items.value.length) return
  reveal(target)
  pinged.value = target
  await nextTick()
  document.getElementById(`plugin-${target}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  window.setTimeout(() => {
    if (pinged.value === target) pinged.value = undefined
  }, 2500)
})

// ---- what the hover hints say ----

function nameTip(item: PluginItem) {
  const lines = [`${item.package}${item.version ? `@${item.version}` : ''}`]
  if (item.description) lines.push(item.description)
  if (item.entry?.local && item.entry.path) lines.push(t('plugins.tip.local', { path: item.entry.path }))
  if (item.requires.length) lines.push(t('plugins.tip.requires', { list: shortList(item.requires.map(nameOf)) }))
  const dependents = [...(relations.value.get(item.package)?.dependents ?? [])]
  if (dependents.length) lines.push(t('plugins.tip.dependents', { list: shortList(dependents.map(nameOf)) }))
  const added = (['commands', 'nodes', 'tools', 'adapters'] as const)
    .filter((key) => item.provides?.[key].length)
    .map((key) => t(`plugins.provides.${key}`, item.provides![key].length))
  if (added.length) lines.push(t('plugins.tip.provides', { list: added.join(t('plugins.provides.separator')) }))
  return lines
}

function toggleTip(item: PluginItem) {
  if (item.kind === 'bot') {
    if (item.chat?.essential) return t('plugins.botEssentialHint')
    return item.enabled ? t('plugins.toggleTip.botOff') : t('plugins.toggleTip.botOn')
  }
  if (item.essential && item.enabled) return t('plugins.toggleTip.essential')
  const others = toggleImpact(item.package, items.value, !item.enabled).map(nameOf)
  if (!item.enabled) return others.length ? t('plugins.toggleTip.enableWith', { list: shortList(others) }) : t('plugins.toggleTip.enable')
  return others.length ? t('plugins.toggleTip.disableWith', { list: shortList(others) }) : t('plugins.toggleTip.disable')
}

function gearTip(item: PluginItem) {
  if (item.kind === 'bot') return { text: t('plugins.gearTip.perBot') }
  if (!item.app?.id) return { text: t('plugins.gearTip.notEntry') }
  const preview = configPreview(item.app.config, item.app.configSchema)
  if (!preview.lines.length) return { text: t('plugins.gearTip.none') }
  return { lines: preview.lines, more: preview.more }
}

/** A status only when it needs saying: running and off are what the switch already shows. */
function stateOf(item: PluginItem) {
  const status = item.status
  if (status === 'failed') return { cls: 'bad', text: t('status.failed') }
  if (status === 'missing' || status === 'pending' || status === 'loading' || status === 'unloading') return { cls: 'warn', text: t(`status.${status}`) }
}

// ---- switching ----

/** A list of plugin names for a confirmation dialog. */
const listOf = (title: string, names: string[]) => (names.length ? [h('p', { style: 'margin: 8px 0 4px' }, title), h('ul', { style: 'margin: 0; padding-left: 20px' }, names.map((name) => h('li', name)))] : [])

function confirmPlan(title: string, body: ReturnType<typeof h>[], positive: string) {
  return new Promise<boolean>((resolve) => {
    dialog.warning({
      title,
      content: () => h('div', body),
      positiveText: positive,
      negativeText: t('common.cancel'),
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
      onMaskClick: () => resolve(false),
    })
  })
}

/** Asks before enabling or disabling other plugins along with this one; resolves to whether to cascade, or undefined to stop. */
async function planFor(plugin: AppPlugin, enabled: boolean): Promise<boolean | undefined> {
  const plan = await call<DependencyPlan>('plugins.dependencies', { package: plugin.package })
  const name = nameOf(plugin.package)
  if (enabled) {
    if (plan.enable.mushin.length) throw new Error(t('plugins.mushinVersion', plan.enable.mushin[0]))
    if (plan.enable.blocked.length) {
      throw new Error(`${t('plugins.requires')}: ${plan.enable.blocked.map((dep) => `${nameOf(dep.package)}（${dep.problem === 'version' ? t('plugins.wrongVersion', { range: dep.range, version: dep.version ?? '?' }) : t('plugins.notInstalled')}）`).join('、')}`)
    }
    const optional = plan.optional.filter((dep) => dep.problem).map((dep) => nameOf(dep.package))
    if (!plan.enable.enable.length) return false
    const ok = await confirmPlan(t('plugins.enableTitle', { name }), [
      ...listOf(t('plugins.enableNeeds'), plan.enable.enable.map(nameOf)),
      ...listOf(t('plugins.enableOptional'), optional),
    ], t('plugins.proceed'))
    return ok ? true : undefined
  }
  const { disable, botPlugins: bots, degraded } = plan.disable
  if (!disable.length && !bots.length && !degraded.length) return false
  const ok = await confirmPlan(t('plugins.disableTitle', { name }), [
    ...listOf(t('plugins.disableAlso'), disable.map((item) => nameOf(item.package))),
    ...listOf(t('plugins.disableBots'), bots.map(nameOf)),
    ...listOf(t('plugins.disableDegraded'), degraded.map(nameOf)),
  ], t('plugins.proceed'))
  return ok ? disable.length > 0 : undefined
}

async function run(pkg: string, task: () => Promise<unknown>) {
  busy.value = pkg
  try {
    await task()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    busy.value = undefined
  }
}

function toggle(item: PluginItem, enabled: boolean) {
  return run(item.package, async () => {
    if (item.kind === 'bot') {
      // Turns a bot plugin on or off for every bot; each bot keeps its own switch.
      await call('bots.plugins.setProject', { package: item.package, enabled })
    } else {
      const plugin = item.app!
      const cascade = await planFor(plugin, enabled)
      if (cascade === undefined) return
      if (enabled) await call('plugins.enable', { package: plugin.package, id: plugin.id || undefined, cascade })
      else await call('plugins.disable', { id: plugin.id, cascade })
    }
    await refresh()
  })
}

/** Turns on the disabled plugins a plugin needs. */
function enableMissing(item: PluginItem) {
  return run(item.package, async () => {
    for (const dep of item.missing.filter((dep) => dep.problem === 'disabled')) await call('plugins.enable', { package: dep.package, cascade: true })
    await refresh()
  })
}

function reload(item: PluginItem) {
  return run(item.package, async () => {
    await call('plugins.reload', { id: item.app!.id })
    message.success(t('plugins.reloaded'))
  })
}

/** Takes an entry out of the config, after saying what goes with it. */
function remove(item: PluginItem) {
  const plugin = item.app!
  return run(item.package, async () => {
    const name = nameOf(plugin.package)
    const plan = plugin.enabled ? (await call<DependencyPlan>('plugins.dependencies', { package: plugin.package })).disable : undefined
    const also = (plan?.disable ?? []).filter((entry) => entry.id !== plugin.id).map((entry) => nameOf(entry.package))
    const ok = await confirmPlan(t('plugins.removeTitle', { name }), [
      h('p', { style: 'margin: 0' }, t('plugins.removeBody')),
      ...listOf(t('plugins.disableAlso'), also),
      ...listOf(t('plugins.disableBots'), (plan?.botPlugins ?? []).map(nameOf)),
    ], t('plugins.remove'))
    if (!ok) return
    await call('plugins.remove', { id: plugin.id, cascade: also.length > 0 })
    message.success(t('plugins.removed', { name }))
    await refresh()
  })
}

// ---- the details panel ----

/** The package open in the panel; the URL says it as ?open=<package>&tab=<section>. */
const openPkg = ref<string>()
const section = ref<PanelSection>((PANEL_SECTIONS as readonly string[]).includes(prefs.pluginPanelSection) ? prefs.pluginPanelSection as PanelSection : 'overview')
const openItem = computed(() => {
  if (!openPkg.value) return undefined
  const installed = itemOf(openPkg.value)
  if (installed) return installed
  const entry = marketEntry(openPkg.value)
  return entry ? marketItem(entry) : undefined
})

// ---- the market tab ----

const installOpen = ref(false)
const installTarget = ref<MarketItem>()
function openInstall(entry: MarketItem) {
  installTarget.value = entry
  installOpen.value = true
}

/** A market package was installed in place: rescan, and turn it on when asked (with the usual dependency questions). */
async function afterInstall(name: string, enable: boolean) {
  await refresh(true)
  const item = itemOf(name)
  if (enable && item?.kind === 'app' && !item.enabled) await toggle(item, true)
}

function openMarketEntry(entry: MarketItem) {
  openPkg.value = entry.name
}

function enableFromMarket(entry: MarketItem) {
  const item = itemOf(entry.name)
  if (item) void toggle(item, true)
}

function open(item: PluginItem, at?: PanelSection) {
  openPkg.value = item.package
  if (at) setSection(at)
}

function setSection(next: PanelSection) {
  section.value = next
  prefs.pluginPanelSection = next
}

function close() {
  openPkg.value = undefined
}

function select(pkg: string) {
  if (!itemOf(pkg)) return
  reveal(pkg)
  openPkg.value = pkg
  nextTick(() => document.getElementById(`plugin-${pkg}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
}

// The URL follows the panel, and opens it when the page is loaded with ?open=.
watch(() => [route.query.open, route.query.tab, items.value.length] as const, ([target, tab]) => {
  if (typeof tab === 'string' && (PANEL_SECTIONS as readonly string[]).includes(tab)) section.value = tab as PanelSection
  if (typeof target === 'string' && items.value.length && target !== openPkg.value && (itemOf(target) || marketEntry(target))) {
    reveal(target)
    openPkg.value = target
  }
}, { immediate: true })

watch([openPkg, section], ([pkg, tab]) => {
  const query = { ...route.query, open: pkg, tab: pkg ? tab : undefined }
  if (query.open === route.query.open && query.tab === route.query.tab) return
  router.replace({ query })
})

/** ↑ and ↓ move the panel to the plugin above or below, unless typing. */
function onKey(event: KeyboardEvent) {
  if (!openItem.value || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || event.altKey || event.ctrlKey || event.metaKey) return
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, select, [contenteditable="true"], [role="listbox"], [role="menu"], [role="radiogroup"]')) return
  const rows = order.value.length ? order.value : items.value
  const index = rows.findIndex((item) => item.package === openPkg.value)
  const next = rows[index < 0 ? 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]
  if (!next) return
  event.preventDefault()
  select(next.package)
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

/** Other plugins that need this one, or use it when present. */
function dependentsOf(item: PluginItem): Dependent[] {
  // The list's own state: a bot plugin's dependent entry says whether it has an app entry, not its project switch.
  if (item.deps?.dependents) return item.deps.dependents.map((dep) => ({ package: dep.package, optional: dep.optional, enabled: itemOf(dep.package)?.enabled ?? dep.enabled }))
  return items.value.flatMap((other): Dependent[] => {
    if (other.requires.includes(item.package)) return [{ package: other.package, optional: false, enabled: other.enabled }]
    if (other.deps?.optional.some((dep) => dep.package === item.package)) return [{ package: other.package, optional: true, enabled: other.enabled }]
    return []
  })
}

// The panel's width is dragged from its left edge, and kept.
const width = ref(prefs.pluginPanelWidth)
const windowWidth = ref(window.innerWidth)
const pageEl = ref<HTMLElement>()
/** Where the page's column sits in the window; the sidebar and the Fairy panel move it. */
const column = ref({ left: 0, right: window.innerWidth })
function measure() {
  windowWidth.value = window.innerWidth
  const box = pageEl.value?.parentElement?.getBoundingClientRect()
  if (box) column.value = { left: box.left, right: box.right }
}
const observer = new ResizeObserver(measure)
onMounted(() => {
  window.addEventListener('resize', measure)
  if (pageEl.value?.parentElement) observer.observe(pageEl.value.parentElement)
  measure()
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', measure)
  observer.disconnect()
})
const panelWidth = computed(() => Math.max(360, Math.min(width.value, windowWidth.value - 80)))

function startResize(event: PointerEvent) {
  event.preventDefault()
  const move = (next: PointerEvent) => (width.value = Math.round(Math.max(380, Math.min(window.innerWidth - next.clientX, window.innerWidth - 240))))
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    document.body.style.cursor = ''
    prefs.pluginPanelWidth = width.value
  }
  document.body.style.cursor = 'col-resize'
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
}

/** Room for the panel beside the list on wide windows, so the list stays in view. */
const pageStyle = computed(() => {
  if (!openItem.value) return undefined
  const panelLeft = windowWidth.value - panelWidth.value
  const covered = column.value.right - panelLeft
  // Too narrow beside the panel: the panel covers the list instead.
  if (covered <= 0 || panelLeft - column.value.left < 680) return undefined
  return { marginRight: `${covered}px` }
})

// ---- plugin folders ----

/** The folders local plugins load from: the app's plugins/ folder, then the extra ones the user added. */
interface PluginFolder { path: string; extra: boolean; exists?: boolean; plugins?: string[] }
const foldersOpen = ref(false)
const folders = ref<PluginFolder[]>([])
const newFolder = ref('')
const savingFolders = ref(false)

async function openFolders() {
  try {
    folders.value = await call<PluginFolder[]>('plugins.folders')
    newFolder.value = ''
    foldersOpen.value = true
  } catch (error) {
    message.error((error as Error).message)
  }
}

function addFolder() {
  const path = newFolder.value.trim()
  if (path && !folders.value.some((folder) => folder.path === path)) folders.value.push({ path, extra: true })
  newFolder.value = ''
}

async function saveFolders() {
  savingFolders.value = true
  try {
    if (newFolder.value.trim()) addFolder()
    folders.value = await call<PluginFolder[]>('plugins.folders.set', { dirs: folders.value.filter((folder) => folder.extra).map((folder) => folder.path) })
    message.success(t('common.saved'))
    foldersOpen.value = false
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    savingFolders.value = false
  }
}
</script>

<template>
  <div ref="pageEl" class="page" :style="pageStyle">
    <PageHeader :title="t('nav.plugins')" :lead="t('plugins.lead')">
      <Button icon="i-lucide-folder-tree" @click="openFolders">{{ t('plugins.folders.title') }}</Button>
      <Button :loading="loading" icon="i-lucide-refresh-cw" @click="rescan">
        {{ t('plugins.rescan') }}
      </Button>
    </PageHeader>

    <UpdateBanner @update="openUpdate()" />

    <nav class="page-tabs" role="tablist">
      <button type="button" role="tab" class="page-tab" :class="{ on: tab === 'installed' }" :aria-selected="tab === 'installed'" @click="goTab('installed')">
        <span class="i-lucide-package-check" />{{ t('market.tabInstalled') }}<span class="count">{{ items.length }}</span>
      </button>
      <button type="button" role="tab" class="page-tab" :class="{ on: tab === 'market' }" :aria-selected="tab === 'market'" @click="goTab('market')">
        <span class="i-lucide-store" />{{ t('market.tabMarket') }}
      </button>
    </nav>

    <div class="toolbar">
      <Input v-model:value="query" clearable :placeholder="t('market.search')" class="search">
        <template #prefix><span class="i-lucide-search" /></template>
      </Input>
      <div v-if="tab === 'installed'" class="chips" role="radiogroup" :aria-label="t('plugins.filterLabel')">
        <button
          v-for="key in filters"
          :key="key"
          type="button"
          role="radio"
          class="chip"
          :class="{ on: filter === key }"
          :aria-checked="filter === key"
          @click="filter = key"
        >
          <span v-if="key === 'updates'" class="i-lucide-circle-arrow-up chip-icon" />
          <span v-else-if="key !== 'all'" class="dot" :class="{ ok: key === 'on', bad: key === 'problem' }" />
          {{ t(`plugins.filter.${key}`) }}
          <span class="count">{{ counts[key] }}</span>
        </button>
      </div>
    </div>

    <MarketGrid
      v-if="tab === 'market'"
      :query="query"
      :enabled-of="(name: string) => itemOf(name)?.enabled"
      @open="openMarketEntry"
      @install="openInstall"
      @enable="enableFromMarket"
      @update="(entry) => openUpdate([entry.name])"
    />
    <Spin v-else :show="loading">
      <section v-for="group in groups" :key="group.key" class="group" :class="{ folded: !group.open }">
        <Tooltip :disabled="group.open" placement="bottom" :max-width="360" :show-arrow="false">
          <template #trigger>
            <button
              type="button"
              class="group-head"
              :aria-expanded="group.open"
              :disabled="!foldable(group) && group.open"
              :aria-label="t('plugins.groupToggle', { name: t(`plugins.groups.${group.key}`) })"
              @click="toggleGroup(group)"
            >
              <span class="i-lucide-chevron-right chevron" :class="{ hidden: !foldable(group) && group.open }" />
              <span :class="GROUP_ICONS[group.key]" class="group-icon" />
              <span class="group-name">{{ t(`plugins.groups.${group.key}`) }}</span>
              <span class="count">{{ t('plugins.groupEnabled', { on: group.enabled, total: group.all.length }) }}</span>
              <span v-if="group.problems" class="problems" :title="t('plugins.groupProblems', group.problems)"><span class="dot bad" />{{ group.problems }}</span>
            </button>
          </template>
          <div class="members">
            <span v-for="item in group.all" :key="item.key" class="member" :class="{ off: !item.enabled }">{{ item.name }}</span>
          </div>
        </Tooltip>

        <ul v-if="group.open && group.shown.length" class="rows">
          <li
            v-for="item in group.shown"
            :id="`plugin-${item.package}`"
            :key="item.key"
            class="row"
            :class="[{ off: !item.enabled, selected: openPkg === item.package, pinged: pinged === item.package }, markOf(item) && `mark-${markOf(item)}`]"
            @mouseenter="hovered = item.package"
            @mouseleave="hovered = undefined"
            @click="open(item)"
          >
            <span class="icon">
              <AdapterIcon v-if="adapterOf(item)" :adapter="adapterOf(item)" :size="20" />
              <span v-else :class="GROUP_ICONS[groupOf(item)]" />
            </span>
            <div class="main">
              <span class="title">
                <Tooltip :max-width="380" placement="top">
                  <template #trigger><strong class="name">{{ item.name }}</strong></template>
                  <div class="tip">
                    <span class="mono tip-pkg">{{ nameTip(item)[0] }}</span>
                    <span v-for="(line, index) in nameTip(item).slice(1)" :key="index">{{ line }}</span>
                  </div>
                </Tooltip>
                <Tooltip v-if="item.essential && item.kind === 'app' && groupOf(item) !== 'core'">
                  <template #trigger><span class="tag">{{ t('plugins.baseService') }}</span></template>
                  {{ t('plugins.baseServiceHint') }}
                </Tooltip>
                <span v-if="item.entry?.local" class="tag warn">{{ t('plugins.local') }}</span>
                <button v-if="updateOf(item)" type="button" class="tag update mono" @click.stop="open(item, 'updates')">{{ updateOf(item)!.current }} → {{ updateOf(item)!.available }}</button>
                <Tooltip v-if="stateOf(item)" :disabled="!item.error" :max-width="360">
                  <template #trigger><span class="pill" :class="stateOf(item)!.cls"><span class="dot" />{{ stateOf(item)!.text }}</span></template>
                  {{ item.error }}
                </Tooltip>
                <Tooltip v-if="item.missing.length" :max-width="320">
                  <template #trigger>
                    <button
                      type="button"
                      class="missing"
                      :disabled="!item.missing.some((dep) => dep.problem === 'disabled') || busy === item.package"
                      @click.stop="enableMissing(item)"
                    >
                      <span class="i-lucide-circle-alert" />{{ t('plugins.missing', { list: list(item.missing.map((dep) => nameOf(dep.package))) }) }}
                    </button>
                  </template>
                  <template v-if="item.missing.some((dep) => dep.problem === 'disabled')">{{ t('plugins.missingEnable', { list: list(item.missing.filter((dep) => dep.problem === 'disabled').map((dep) => nameOf(dep.package))) }) }}</template>
                  <template v-else>{{ t('plugins.missingInstall', { list: list(item.missing.map((dep) => nameOf(dep.package))) }) }}</template>
                </Tooltip>
              </span>
              <span class="desc">{{ item.description }}</span>
            </div>
            <div class="actions" @click.stop>
              <Tooltip v-if="item.kind === 'app'" :max-width="360" placement="top">
                <template #trigger>
                  <Button quaternary circle size="small" icon="i-lucide-settings" class="gear" :aria-label="t('common.configure')" @click="open(item, 'config')" />
                </template>
                <div v-if="gearTip(item).lines" class="tip">
                  <span v-for="line in gearTip(item).lines" :key="line.key" class="mono"><span class="tip-key">{{ line.key }}:</span> {{ line.value }}</span>
                  <span v-if="gearTip(item).more">{{ t('plugins.gearTip.more', { n: gearTip(item).more }) }}</span>
                </div>
                <template v-else>{{ gearTip(item).text }}</template>
              </Tooltip>
              <Tooltip v-if="item.kind === 'app' || item.chat" :max-width="320" placement="top">
                <template #trigger>
                  <span class="toggle-wrap">
                    <Toggle
                      variant="button"
                      :value="item.enabled"
                      :disabled="(item.essential && item.enabled)"
                      :loading="busy === item.package"
                      :aria-label="item.name"
                      @update:value="(value: boolean) => toggle(item, value)"
                    />
                  </span>
                </template>
                {{ toggleTip(item) }}
              </Tooltip>
            </div>
          </li>
        </ul>
        <p v-else-if="group.open && group.key === 'bot' && !group.all.length && !loading" class="faint none">{{ t('plugins.noBotPlugins') }}</p>
      </section>
      <div v-if="!loading && !groups.length" class="none">
        <p class="faint">{{ t('plugins.noMatch') }}</p>
        <Button v-if="query.trim()" size="small" icon="i-lucide-store" @click="goTab('market')">{{ t('market.searchMarket', { query: query.trim() }) }}</Button>
      </div>
    </Spin>

    <Drawer
      :show="!!openItem"
      :modal="false"
      :width="panelWidth"
      :label="openItem?.name"
      class="plugin-drawer"
      @update:show="(value: boolean) => !value && close()"
    >
      <div class="resize" :title="t('plugins.panel.resize')" @pointerdown="startResize" />
      <PluginPanel
        v-if="openItem"
        :item="openItem"
        :group="groupOf(openItem)"
        :adapter="adapterOf(openItem)"
        :busy="busy === openItem.package"
        :toggle-tip="toggleTip(openItem)"
        :section="section"
        :name-of="nameOf"
        :dependents="dependentsOf(openItem)"
        :bots="data.bots"
        :flows="flows"
        :update="pluginUpdate(openItem.package)"
        @update:section="setSection"
        @toggle="(value) => toggle(openItem!, value)"
        @reload="reload(openItem!)"
        @remove="remove(openItem!)"
        @close="close"
        @select="select"
        @hover-dep="(pkg) => (pinged = pkg)"
        @enable-missing="enableMissing(openItem!)"
        @saved="refresh()"
        @update="(preset) => openUpdate(preset)"
        @install="openItem.market && openInstall(openItem.market)"
        @uninstalled="() => { close(); refresh(true) }"
      />
    </Drawer>

    <UpdateDialog v-model:show="updateOpen" :preset="updatePreset" />
    <InstallDialog v-model:show="installOpen" :entry="installTarget" @installed="afterInstall" />

    <Modal :show="foldersOpen" :title="t('plugins.folders.title')" :width="600" @update:show="(value: boolean) => !value && (foldersOpen = false)">
      <p class="faint folders-lead">{{ t('plugins.folders.lead') }}</p>
      <ul class="folders">
        <li v-for="(folder, index) in folders" :key="folder.path" class="folder">
          <span class="i-lucide-folder folder-icon" />
          <span class="mono folder-path" :title="folder.path">{{ folder.path }}</span>
          <!-- The app's plugins/ folder appears with its first plugin; a missing extra folder is worth a warning. -->
          <span v-if="folder.exists === false && folder.extra" class="tag warn">{{ t('plugins.folders.missing') }}</span>
          <span v-else-if="folder.plugins" class="faint">{{ t('plugins.folders.count', folder.plugins.length) }}</span>
          <span v-if="!folder.extra" class="tag">{{ t('plugins.folders.app') }}</span>
          <IconAction v-else icon="i-lucide-x" :label="t('common.remove')" @click="folders.splice(index, 1)" />
        </li>
      </ul>
      <form class="folder-add" @submit.prevent="addFolder">
        <Input v-model:value="newFolder" class="mono" :placeholder="t('plugins.folders.placeholder')" />
        <Button attr-type="submit" :disabled="!newFolder.trim()">{{ t('common.add') }}</Button>
      </form>
      <p class="faint">{{ t('plugins.folders.hint') }}</p>
      <template #footer>
        <Button @click="foldersOpen = false">{{ t('common.cancel') }}</Button>
        <Button type="primary" :loading="savingFolders" @click="saveFolders">{{ t('common.save') }}</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.page {
  transition: margin-right 0.2s;
}

.page-tabs {
  display: flex;
  gap: 4px;
  margin: 0 0 14px;
  border-bottom: 1px solid var(--line);
}

.page-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px 9px;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: none;
  color: var(--fg2);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}

.page-tab:hover {
  color: var(--fg);
}

.page-tab.on {
  color: var(--primary);
  border-bottom-color: var(--primary);
}

.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin-bottom: 20px;
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
.group-head:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.count {
  font-size: 12px;
  font-weight: 400;
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

.group + .group {
  margin-top: 18px;
}

.group.folded + .group {
  margin-top: 6px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin: 0 0 8px;
  padding: 4px 6px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.group-head:hover:not(:disabled) {
  background: var(--s2);
}

.group-head:disabled {
  cursor: default;
}

.group.folded .group-head {
  margin-bottom: 0;
}

.chevron {
  flex: none;
  color: var(--fg3);
  transition: transform 0.15s;
}

.group:not(.folded) .chevron {
  transform: rotate(90deg);
}

.chevron.hidden {
  visibility: hidden;
}

.group-icon {
  color: var(--fg3);
  font-size: 15px;
}

.group-name {
  font-size: 15px;
  font-weight: 600;
}

.problems {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--bad);
}

.problems .dot {
  width: 7px;
  height: 7px;
}

.members {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
}

.member.off {
  opacity: 0.6;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
  overflow: hidden;
}

/* An icon, the name and a line of description, then the gear and the switch. */
.row {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0 12px;
  padding: 10px 12px 10px 14px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.row + .row {
  border-top: 1px solid var(--line);
}

.row:hover {
  background: var(--s2);
}

.row.selected {
  background: var(--primary-soft);
}

.row.pinged {
  background: var(--primary-soft);
  box-shadow: inset 0 0 0 1px var(--primary);
}

/* While another row is hovered: what it needs, and what needs it. */
.row::before {
  content: '';
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: 0;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: transparent;
  transition: background-color 0.15s;
}

.row.mark-needed::before {
  background: var(--primary);
}

.row.mark-needs::before {
  background: var(--warn);
}

.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--s2);
  color: var(--fg2);
  font-size: 17px;
}

.row:hover .icon,
.row.selected .icon {
  background: var(--s1);
}

.main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row.off .name,
.row.off .desc {
  color: var(--fg2);
}

.row.off .icon {
  opacity: 0.65;
}

.desc {
  font-size: 13px;
  color: var(--fg2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: default;
}

.toggle-wrap {
  display: inline-flex;
}

.gear {
  color: var(--fg3);
}

.missing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 8px;
  border: none;
  border-radius: 10px;
  background: var(--bad-soft);
  color: var(--bad);
  font: inherit;
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
}

.missing:disabled {
  cursor: default;
}

.missing:not(:disabled):hover {
  box-shadow: inset 0 0 0 1px var(--bad);
}

.tip {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.tip-pkg {
  opacity: 0.8;
  font-size: 12px;
}

.tip-key {
  opacity: 0.7;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 8px;
  border-radius: 10px;
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
}

.pill .dot {
  width: 6px;
  height: 6px;
  background: currentColor;
}

.pill.warn { color: var(--warn); background: var(--warn-soft); }
.pill.bad { color: var(--bad); background: var(--bad-soft); }

.tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: 10px;
  font-size: 11.5px;
  white-space: nowrap;
  color: var(--fg2);
  background: var(--s2);
}

.row:hover .tag {
  background: var(--s1);
}

.tag.update {
  border: none;
  color: var(--primary);
  background: var(--primary-soft);
  font-size: 11px;
  cursor: pointer;
}

.chip-icon {
  font-size: 13px;
  color: var(--primary);
}

.tag.warn {
  color: var(--warn);
  background: var(--warn-soft);
}

.faint {
  margin: 0;
  font-size: 12.5px;
  color: var(--fg3);
}

.none {
  padding: 12px 6px;
}

.resize {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px;
  z-index: 3;
  width: 7px;
  cursor: col-resize;
}

.resize:hover {
  background: color-mix(in srgb, var(--primary) 30%, transparent);
}

.folders-lead {
  margin-bottom: 12px;
}

.folders {
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: 10px;
}

.folder {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 4px 8px 4px 12px;
}

.folder + .folder {
  border-top: 1px solid var(--line);
}

.folder-icon {
  flex: none;
  color: var(--fg3);
}

.folder-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12.5px;
}

.folder-add {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.folder-add > :first-child {
  flex: 1;
}

@media (max-width: 640px) {
  .row {
    grid-template-columns: auto minmax(0, 1fr);
    gap: 8px 12px;
  }

  .actions {
    grid-column: 1 / -1;
    justify-content: flex-end;
  }

  .desc {
    white-space: normal;
  }
}
</style>
