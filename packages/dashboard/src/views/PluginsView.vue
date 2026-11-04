<script setup lang="ts">
import { Button, Empty, Input, Modal, Spin, Toggle, Tooltip, useConfirm, useToast } from '@mushin/ui'
import IconAction from '../components/IconAction.vue'
import PageHeader from '../components/PageHeader.vue'
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { call, on } from '../api'
import DependencyTags from '../components/DependencyTags.vue'
import SchemaForm from '../components/SchemaForm.vue'
import type { AppPlugin, CatalogEntry, DependencyPlan, PluginDependencies } from '../types'
import { clone, localize } from '../utils'

const { t, locale } = useI18n()
const message = useToast()
const dialog = useConfirm()
const route = useRoute()


const plugins = ref<AppPlugin[]>([])
const appCatalog = ref<CatalogEntry[]>([])
const botPlugins = ref<CatalogEntry[]>([])
const loading = ref(true)
const busy = ref<string>()
const editing = ref<AppPlugin>()
const draft = ref<Record<string, any>>({})
const jsonDraft = ref('')
const saving = ref(false)

/** /plugins?highlight=<package> scrolls to that plugin and makes it stand out for a moment. */
const highlighted = ref<string>()
watch(() => [route.query.highlight, plugins.value.length] as const, async ([target]) => {
  if (typeof target !== 'string' || !plugins.value.length) return
  highlighted.value = target
  await nextTick()
  document.getElementById(`plugin-${target}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  window.setTimeout(() => (highlighted.value = undefined), 2500)
})

async function refresh(rescan = false) {
  try {
    const [list, catalog] = await Promise.all([
      call<AppPlugin[]>('plugins.list'),
      call<CatalogEntry[]>('plugins.catalog', { refresh: rescan }),
    ])
    plugins.value = list
    appCatalog.value = catalog.filter((entry) => entry.manifest.kind === 'app')
    botPlugins.value = catalog.filter((entry) => entry.manifest.kind === 'bot')
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(() => refresh())

/** Configured entries, then installed app plugins that were never enabled (they have no entry id yet). */
const appPlugins = computed<AppPlugin[]>(() => [
  ...plugins.value,
  ...appCatalog.value
    .filter((entry) => !plugins.value.some((plugin) => plugin.package === entry.package))
    .map((entry) => ({ id: '', package: entry.package, enabled: false, config: {}, manifest: entry.manifest, version: entry.version, status: 'disabled' as const })),
])

const keyOf = (plugin: AppPlugin) => plugin.id || plugin.package
const catalog = computed(() => [...appCatalog.value, ...botPlugins.value])
const nameOf = (pkg: string) => localize(catalog.value.find((entry) => entry.package === pkg)?.manifest.displayName, locale.value) || pkg

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

async function enableDeps(plugin: AppPlugin) {
  const missing = (depsOf(plugin)?.requires ?? []).filter((dep) => dep.problem === 'disabled')
  busy.value = keyOf(plugin)
  try {
    for (const dep of missing) await call('plugins.enable', { package: dep.package, cascade: true })
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    busy.value = undefined
  }
}

async function rescan() {
  loading.value = true
  await refresh(true)
  message.success(t('plugins.rescanned'))
}
let timer: number | undefined
const off = on('manager/changed', () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => refresh(), 150)
})
onBeforeUnmount(off)

async function toggle(plugin: AppPlugin, enabled: boolean) {
  busy.value = keyOf(plugin)
  try {
    const cascade = await planFor(plugin, enabled)
    if (cascade === undefined) return
    if (enabled) await call('plugins.enable', { package: plugin.package, id: plugin.id || undefined, cascade })
    else await call('plugins.disable', { id: plugin.id, cascade })
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    busy.value = undefined
  }
}

async function reload(plugin: AppPlugin) {
  busy.value = plugin.id
  try {
    await call('plugins.reload', { id: plugin.id })
    message.success(t('plugins.reloaded'))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    busy.value = undefined
  }
}

function configure(plugin: AppPlugin) {
  editing.value = plugin
  draft.value = clone(plugin.config)
  jsonDraft.value = JSON.stringify(plugin.config, null, 2)
}

// ---- search, filters and the rows' details ----

type Filter = 'all' | 'on' | 'problem' | 'off'
const query = ref('')
const filter = ref<Filter>('all')
const expanded = ref(new Set<string>())

/** Something the person should look at: it failed, waits on a dependency, or needs one that is missing. */
function hasProblem(plugin: AppPlugin) {
  if (plugin.status === 'failed' || plugin.status === 'missing' || plugin.status === 'pending') return true
  return !!depsOf(plugin)?.requires.some((dep) => dep.problem && dep.problem !== 'not-app')
}

function stateOf(plugin: AppPlugin): { cls: string, text: string } {
  if (plugin.status === 'failed') return { cls: 'bad', text: t('status.failed') }
  if (plugin.status === 'missing' || plugin.status === 'pending') return { cls: 'warn', text: t(`status.${plugin.status}`) }
  if (plugin.status === 'loading' || plugin.status === 'unloading') return { cls: 'warn', text: t(`status.${plugin.status}`) }
  if (plugin.status === 'active') return { cls: 'ok', text: t('status.active') }
  return { cls: 'idle', text: t('status.disabled') }
}

const counts = computed(() => ({
  all: appPlugins.value.length,
  on: appPlugins.value.filter((plugin) => plugin.enabled).length,
  problem: appPlugins.value.filter(hasProblem).length,
  off: appPlugins.value.filter((plugin) => !plugin.enabled).length,
}))

const filters = computed(() => (['all', 'on', 'problem', 'off'] as const).filter((key) => key === 'all' || counts.value[key] > 0 || filter.value === key))

const matches = (text: string, ...values: (string | undefined)[]) => !text || values.some((value) => value?.toLowerCase().includes(text))

const shownApp = computed(() => {
  const text = query.value.trim().toLowerCase()
  return appPlugins.value.filter((plugin) => {
    if (filter.value === 'on' && !plugin.enabled) return false
    if (filter.value === 'off' && plugin.enabled) return false
    if (filter.value === 'problem' && !hasProblem(plugin)) return false
    return matches(text, plugin.package, localize(plugin.manifest?.displayName, locale.value), localize(plugin.manifest?.description, locale.value))
  })
})

const shownBot = computed(() => {
  const text = query.value.trim().toLowerCase()
  if (filter.value !== 'all') return []
  return botPlugins.value.filter((entry) => matches(text, entry.package, localize(entry.manifest.displayName, locale.value), localize(entry.manifest.description, locale.value)))
})

/** "Needed by N plugins" on the row; the names are in the details. */
const dependentCount = (plugin: AppPlugin) => (depsOf(plugin)?.dependents ?? []).filter((dep) => !dep.optional).length

function toggleDetails(key: string) {
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}

const asPlugin = (entry: CatalogEntry): AppPlugin => ({ id: '', package: entry.package, enabled: false, config: {}, manifest: entry.manifest, status: 'disabled' })

async function save() {
  if (!editing.value) return
  saving.value = true
  try {
    const config = editing.value.configSchema ? draft.value : JSON.parse(jsonDraft.value || '{}')
    await call('plugins.configure', { id: editing.value.id, config })
    editing.value = undefined
    message.success(t('common.saved'))
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader :title="t('nav.plugins')" :lead="t('plugins.lead')">
      <Button :loading="loading" icon="i-lucide-refresh-cw" @click="rescan">
        {{ t('plugins.rescan') }}
      </Button>
    </PageHeader>

    <div class="toolbar">
      <Input v-model:value="query" clearable :placeholder="t('plugins.search')" class="search">
        <template #prefix><span class="i-lucide-search" /></template>
      </Input>
      <div class="chips" role="radiogroup" :aria-label="t('plugins.filterLabel')">
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
          <span v-if="key !== 'all'" class="dot" :class="{ ok: key === 'on', bad: key === 'problem' }" />
          {{ t(`plugins.filter.${key}`) }}
          <span class="count">{{ counts[key] }}</span>
        </button>
      </div>
    </div>

    <Spin :show="loading">
      <section class="section">
        <h2 class="section-title">{{ t('plugins.appPlugins') }} <span class="count">{{ shownApp.length }}</span></h2>
        <ul v-if="shownApp.length" class="rows">
          <li
            v-for="plugin in shownApp"
            :id="`plugin-${plugin.package}`"
            :key="keyOf(plugin)"
            class="row"
            :class="{ highlighted: highlighted === plugin.package, off: !plugin.enabled, open: expanded.has(keyOf(plugin)) }"
          >
            <button type="button" class="row-main" :aria-expanded="expanded.has(keyOf(plugin))" @click="toggleDetails(keyOf(plugin))">
              <span class="title">
                <strong>{{ localize(plugin.manifest?.displayName, locale) || plugin.package }}</strong>
                <Tooltip v-if="plugin.error" :max-width="320">
                  <template #trigger><span class="pill" :class="stateOf(plugin).cls"><span class="dot" />{{ stateOf(plugin).text }}</span></template>
                  {{ plugin.error }}
                </Tooltip>
                <span v-else class="pill" :class="stateOf(plugin).cls"><span class="dot" />{{ stateOf(plugin).text }}</span>
                <Tooltip v-if="plugin.manifest?.essential">
                  <template #trigger><span class="tag">{{ t('plugins.essential') }}</span></template>
                  {{ t('plugins.essentialHint') }}
                </Tooltip>
                <span v-if="hasProblem(plugin) && plugin.status !== 'failed'" class="tag warn">{{ t('plugins.needsAttention') }}</span>
              </span>
              <span class="desc">{{ localize(plugin.manifest?.description, locale) }}</span>
              <span class="meta">
                <span class="mono">{{ plugin.package }}{{ plugin.version ? `@${plugin.version}` : '' }}</span>
                <template v-if="dependentCount(plugin)">
                  <span class="sep">·</span>
                  <span>{{ t('plugins.neededBy', dependentCount(plugin)) }}</span>
                </template>
                <span class="i-lucide-chevron-down chevron text-[14px]" />
              </span>
            </button>
            <div class="actions">
              <IconAction icon="i-lucide-refresh-cw" :label="t('common.reload')" :disabled="!plugin.enabled" @click="reload(plugin)" />
              <IconAction icon="i-lucide-settings" :label="t('common.configure')" :disabled="!plugin.id" @click="configure(plugin)" />
              <Toggle
                variant="button"
                :value="plugin.enabled"
                :disabled="plugin.manifest?.essential && plugin.enabled"
                :loading="busy === keyOf(plugin)"
                :aria-label="localize(plugin.manifest?.displayName, locale) || plugin.package"
                @update:value="(value: boolean) => toggle(plugin, value)"
              />
            </div>
            <div v-if="expanded.has(keyOf(plugin)) || hasProblem(plugin)" class="details">
              <DependencyTags :deps="depsOf(plugin)" :catalog="catalog" :show-dependents="expanded.has(keyOf(plugin))" @enable-deps="enableDeps(plugin)" />
              <p v-if="expanded.has(keyOf(plugin)) && !depsOf(plugin)?.requires.length && !depsOf(plugin)?.optional.length && !dependentCount(plugin)" class="faint">{{ t('plugins.noDeps') }}</p>
            </div>
          </li>
        </ul>
        <Empty v-else-if="!loading" :description="t('plugins.noMatch')" class="none" />
      </section>

      <section v-if="filter === 'all'" class="section">
        <h2 class="section-title">{{ t('plugins.botPlugins') }} <span class="count">{{ shownBot.length }}</span></h2>
        <p class="section-lead">{{ t('plugins.botPluginsHint') }}</p>
        <ul v-if="shownBot.length" class="rows">
          <li v-for="entry in shownBot" :key="entry.package" class="row static">
            <div class="row-main">
              <span class="title">
                <strong>{{ localize(entry.manifest.displayName, locale) || entry.package }}</strong>
                <span v-for="platform in entry.manifest.platforms ?? []" :key="platform" class="tag">{{ platform }}</span>
                <span v-if="entry.local" class="tag warn">{{ t('plugins.local') }}</span>
              </span>
              <span class="desc">{{ localize(entry.manifest.description, locale) }}</span>
              <span class="meta"><span class="mono">{{ entry.package }}@{{ entry.version }}</span></span>
            </div>
            <div class="details">
              <DependencyTags :deps="depsOf(asPlugin(entry))" :catalog="catalog" />
            </div>
          </li>
        </ul>
        <p v-else-if="!loading" class="faint none">{{ query ? t('plugins.noMatch') : t('plugins.noBotPlugins') }}</p>
      </section>
    </Spin>

    <Modal
      :show="!!editing"
      :title="editing ? localize(editing.manifest?.displayName, locale) || editing.package : ''"
      :width="560"
      @update:show="(value: boolean) => !value && (editing = undefined)"
    >
      <SchemaForm v-if="editing?.configSchema" v-model="draft" :schema="editing.configSchema" />
      <template v-else-if="editing">
        <p class="faint">{{ t('plugins.rawConfig') }}</p>
        <Input v-model:value="jsonDraft" type="textarea" class="mono" :autosize="{ minRows: 6, maxRows: 20 }" />
      </template>
      <template #footer>
        <Button @click="editing = undefined">{{ t('common.cancel') }}</Button>
        <Button type="primary" :loading="saving" @click="save">{{ t('common.saveAndReload') }}</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
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
.row-main:focus-visible {
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

.section + .section {
  margin-top: 32px;
}

.section-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
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

/* One line of name and status, one of description, one of package and dependents. */
.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0 16px;
  padding: 12px 16px;
  transition: background-color 0.4s;
}

.row + .row {
  border-top: 1px solid var(--line);
}

.row.highlighted {
  background: var(--primary-soft);
}

.row-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.row.static .row-main {
  cursor: default;
}

.title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.title strong {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row.off .title strong,
.row.off .desc {
  color: var(--fg2);
}

.desc {
  font-size: 13px;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fg3);
  min-width: 0;
}

.meta .mono {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sep {
  color: var(--fg3);
}

.chevron {
  flex: none;
  transition: transform 0.2s;
}

.row.open .chevron {
  transform: rotate(180deg);
}

.actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.details {
  grid-column: 1 / -1;
  margin-top: 8px;
}

.details:empty {
  display: none;
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

.pill.ok { color: var(--ok); background: var(--ok-soft); }
.pill.warn { color: var(--warn); background: var(--warn-soft); }
.pill.bad { color: var(--bad); background: var(--bad-soft); }
.pill.idle { color: var(--fg2); background: var(--s2); }

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
  padding: 24px 0;
}

@media (max-width: 640px) {
  .row {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }

  .actions {
    justify-content: flex-end;
  }

  .desc {
    white-space: normal;
  }
}
</style>
