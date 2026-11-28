<script setup lang="ts">
import { Button, Dropdown, type DropdownOption, Toggle, Tooltip, useConfirm, useToast } from '@mushinjs/ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { GROUP_ICONS, PANEL_SECTIONS, type PanelSection, type PluginItem } from '../../plugins/item'
import type { GroupKey } from '../../plugins/groups'
import type { AdapterType, Bot, DependencyState, FlowSummary } from '../../types'
import AdapterIcon from '../AdapterIcon.vue'
import PluginConfig from './PluginConfig.vue'
import { type PluginUpdateInfo, updates } from '../../updates'
import { call } from '../../api'
import { installBlocker, market, type MarketDetail, renderReadme, uninstallPackage } from '../../market'
import type { LogLine } from '../../types'

/** Another plugin's relation to this one, for the dependencies section. */
export interface Dependent {
  package: string
  optional: boolean
  enabled: boolean
}

/**
 * Everything about one plugin, in the details panel beside the list: a header that stays on top with its switch and
 * menu, a row of section names that scroll to the sections, and the sections themselves.
 */
const props = defineProps<{
  item: PluginItem
  group: GroupKey
  adapter?: AdapterType
  busy?: boolean
  toggleTip: string
  section: PanelSection
  nameOf: (pkg: string) => string
  dependents: Dependent[]
  bots: Bot[]
  flows: FlowSummary[]
  /** Its newer version on npm, for third-party plugins. */
  update?: PluginUpdateInfo
}>()

const emit = defineEmits<{
  toggle: [value: boolean]
  reload: []
  remove: []
  close: []
  select: [pkg: string]
  hoverDep: [pkg: string | undefined]
  enableMissing: []
  saved: []
  'update:section': [section: PanelSection]
  /** Open the update dialog with these ticked: `mushin`, or package names. */
  update: [preset: string[]]
  /** Install this market package (opens the install dialog). */
  install: []
  /** It was uninstalled in place; the list changes. */
  uninstalled: []
}>()

const { t, locale } = useI18n()
const dialog = useConfirm()
const message = useToast()

/** The sections this plugin has: a package that is not installed has no usage, settings, contents or logs. */
const sections = computed(() => PANEL_SECTIONS.filter((section) => {
  if (!props.item.installed) return ['overview', 'deps', 'readme', 'updates'].includes(section)
  if (section === 'readme') return !!props.item.market
  if (section === 'logs') return props.item.kind === 'app'
  return true
}))

const root = ref<HTMLElement>()
const head = ref<HTMLElement>()
const sectionEls = ref<Partial<Record<PanelSection, HTMLElement>>>({})
const active = ref<PanelSection>(props.section)

const scroller = () => root.value?.closest('.mu-drawer__body') as HTMLElement | null

function scrollTo(section: PanelSection, smooth = true) {
  const box = scroller()
  const el = sectionEls.value[section]
  if (!box || !el) return
  const top = el.offsetTop - (head.value?.offsetHeight ?? 0) - 4
  box.scrollTo({ top: section === 'overview' ? 0 : top, behavior: smooth ? 'smooth' : 'auto' })
  active.value = section
}

function pick(section: PanelSection) {
  emit('update:section', section)
  scrollTo(section)
}

/** The section at the top while scrolling, so its name is marked. */
function onScroll() {
  const box = scroller()
  if (!box) return
  const line = box.scrollTop + (head.value?.offsetHeight ?? 0) + 12
  let current: PanelSection = 'overview'
  for (const section of sections.value) {
    const el = sectionEls.value[section]
    if (el && el.offsetTop <= line) current = section
  }
  // At the bottom, the last sections may never reach the top.
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) {
    const last = sections.value.findLast((section) => sectionEls.value[section])
    if (last && (sectionEls.value[last]!.offsetTop > line)) current = last
  }
  active.value = current
}

onMounted(() => {
  scroller()?.addEventListener('scroll', onScroll, { passive: true })
  nextTick(() => scrollTo(props.section, false))
})
onBeforeUnmount(() => scroller()?.removeEventListener('scroll', onScroll))

// Another plugin opens at the section last chosen.
watch(() => props.item.key, () => nextTick(() => scrollTo(props.section, false)))
watch(() => props.section, (section) => {
  if (section !== active.value) nextTick(() => scrollTo(section))
})

const app = computed(() => props.item.app)
const updateInfo = computed(() => updates.info)
/** Official packages (and the Cordis ones they bring) update with Mushin.js. */
const official = computed(() => props.item.package.startsWith('@mushinjs/') || props.item.package.startsWith('@cordisjs/'))
const name = computed(() => props.item.name)

/** A third-party package the app installed from npm, which can be uninstalled from here. */
const uninstallable = computed(() => {
  const mine = props.item.market?.installed
  if (mine) return mine.ownDependency && !mine.builtin && !mine.local
  return props.item.installed && !official.value && !props.item.entry?.local && !!props.item.entry
})

const menu = computed<DropdownOption[]>(() => [
  ...(props.item.kind === 'app' ? [{ key: 'reload', label: t('common.reload'), icon: 'i-lucide-refresh-cw', disabled: !app.value?.id || !props.item.enabled }] : []),
  ...(app.value?.id && !props.item.essential ? [{ type: 'divider' as const }, { key: 'remove', label: t('plugins.remove'), icon: 'i-lucide-trash-2', danger: true }] : []),
  ...(uninstallable.value ? [{ type: 'divider' as const }, { key: 'uninstall', label: t('market.uninstall'), icon: 'i-lucide-package-minus', danger: true, disabled: !!installBlocker(market.listing) }] : []),
])

function onMenu(key: string) {
  if (key === 'reload') emit('reload')
  if (key === 'remove') emit('remove')
  if (key === 'uninstall') uninstall()
}

function uninstall() {
  dialog.warning({
    title: t('market.uninstallTitle', { name: name.value }),
    content: t('market.uninstallBody'),
    positiveText: t('market.uninstall'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        const result = await uninstallPackage(props.item.package)
        if (!result.restart) {
          message.success(t('market.uninstalledNow', { name: name.value }))
          emit('uninstalled')
        }
      } catch (error) {
        message.error((error as Error).message)
      }
    },
  })
}

// ---- logs ----

const logs = ref<LogLine[]>()
async function loadLogs() {
  logs.value = undefined
  if (!props.item.installed || props.item.kind !== 'app') return
  logs.value = await call<LogLine[]>('logs.recent', { plugin: props.item.package, limit: 30 }).catch(() => [])
}
const clock = (ts: number) => new Date(ts).toTimeString().slice(0, 8)

// ---- README and versions, from the market ----

const detail = ref<MarketDetail>()
const detailLoading = ref(false)
async function loadDetail() {
  detail.value = undefined
  if (!props.item.market) return
  detailLoading.value = true
  try {
    detail.value = await call<MarketDetail>('market.package', { name: props.item.package })
  } catch {
    detail.value = undefined
  } finally {
    detailLoading.value = false
  }
}
const readme = computed(() => {
  const text = detail.value?.readme ?? props.item.market?.readme
  return text ? renderReadme(text) : ''
})
watch(() => props.item.key, () => {
  void loadLogs()
  void loadDetail()
}, { immediate: true })
const marketChoice = computed(() => props.item.market?.choice)
const blocker = computed(() => installBlocker(market.listing))
const dateText = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(locale.value) : '')

const status = computed(() => {
  const value = props.item.status
  if (props.item.kind === 'bot') return props.item.enabled ? { cls: 'ok', text: t('status.active') } : { cls: 'idle', text: t('status.disabled') }
  if (value === 'failed') return { cls: 'bad', text: t('status.failed') }
  if (value === 'missing' || value === 'pending' || value === 'loading' || value === 'unloading') return { cls: 'warn', text: t(`status.${value}`) }
  if (value === 'active') return { cls: 'ok', text: t('status.active') }
  return { cls: 'idle', text: t('status.disabled') }
})

// ---- in use ----

const botName = (id: string) => props.bots.find((bot) => bot.id === id)?.name ?? id
const chatBots = computed(() => props.item.chat?.bots ?? [])
const adapterBots = computed(() => {
  const types = new Set(props.item.provides?.adapters ?? [])
  return types.size ? props.bots.filter((bot) => types.has(bot.adapter.type)) : []
})
const ownFlows = computed(() => props.flows.filter((flow) => flow.source?.plugin === props.item.package))
const unused = computed(() => !chatBots.value.length && !adapterBots.value.length && !ownFlows.value.length)

// ---- dependencies ----

function depState(dep: DependencyState) {
  switch (dep.problem) {
    case 'not-installed': return { cls: 'bad', text: t('plugins.notInstalled') }
    case 'version': return { cls: 'bad', text: t('plugins.wrongVersion', { range: dep.range, version: dep.version ?? '?' }) }
    case 'disabled': return { cls: dep.optional ? 'idle' : 'bad', text: t('plugins.notEnabled') }
    default: return { cls: 'ok', text: t('plugins.panel.enabled') }
  }
}

const requires = computed(() => (props.item.deps?.requires ?? []).filter((dep) => dep.problem !== 'not-app' || dep.kind !== 'bot'))
const optional = computed(() => props.item.deps?.optional ?? [])
const needed = computed(() => props.dependents.filter((dep) => !dep.optional))
const usedBy = computed(() => props.dependents.filter((dep) => dep.optional))
const fixable = computed(() => props.item.missing.some((dep) => dep.problem === 'disabled'))
const noDeps = computed(() => !requires.value.length && !optional.value.length && !props.dependents.length)

// ---- contents ----

const KINDS = [
  { key: 'commands', icon: 'i-lucide-square-slash' },
  { key: 'nodes', icon: 'i-lucide-workflow' },
  { key: 'tools', icon: 'i-lucide-wrench' },
  { key: 'adapters', icon: 'i-lucide-plug' },
] as const

const contents = computed(() => KINDS.filter(({ key }) => props.item.provides?.[key].length).map(({ key, icon }) => {
  const names = props.item.provides![key]
  return { key, icon, names: key === 'commands' ? names.map((value) => `/${value}`) : names }
}))

defineExpose({ scrollTo })
</script>

<template>
  <div ref="root" class="panel">
    <header ref="head" class="head">
      <div class="head-main">
        <span class="icon">
          <AdapterIcon v-if="adapter" :adapter="adapter" :size="22" />
          <span v-else :class="GROUP_ICONS[group]" />
        </span>
        <div class="head-text">
          <h2 class="name">{{ name }}</h2>
          <span class="mono sub">{{ item.package }}<template v-if="item.version">@{{ item.version }}</template></span>
        </div>
        <template v-if="!item.installed">
          <Tooltip :disabled="!blocker && !!marketChoice?.version && item.market?.allowed !== false" :max-width="320">
            <template #trigger>
              <span><Button type="primary" size="small" icon="i-lucide-download" :disabled="!!blocker || !marketChoice?.version || item.market?.allowed === false" @click="emit('install')">{{ marketChoice?.version ? t('market.install') : t('market.incompatible') }}</Button></span>
            </template>
            {{ blocker === 'development' ? t('market.development') : blocker === 'supervisor' ? t('market.needsSupervisor') : !marketChoice?.version ? t('market.needs', { range: marketChoice?.needs }) : t('market.notAllowed') }}
          </Tooltip>
        </template>
        <Tooltip v-else-if="item.kind === 'app' || item.chat" :max-width="320">
          <template #trigger>
            <span class="toggle-wrap">
              <Toggle
                variant="button"
                size="small"
                :value="item.enabled"
                :disabled="(item.essential && item.enabled) || (item.kind === 'bot' && item.chat?.essential)"
                :loading="busy"
                :aria-label="name"
                @update:value="(value: boolean) => emit('toggle', value)"
              />
            </span>
          </template>
          {{ toggleTip }}
        </Tooltip>
        <Dropdown v-if="item.installed && menu.length" :options="menu" align="end" @select="onMenu">
          <Button quaternary circle size="small" icon="i-lucide-ellipsis" :aria-label="t('plugins.panel.more')" />
        </Dropdown>
        <Button quaternary circle size="small" icon="i-lucide-x" :aria-label="t('common.close')" @click="emit('close')" />
      </div>
      <nav class="tabs" :aria-label="name">
        <button
          v-for="section in sections"
          :key="section"
          type="button"
          class="tab"
          :class="{ on: active === section }"
          @click="pick(section)"
        >
          {{ t(`plugins.panel.sections.${section}`) }}
        </button>
      </nav>
    </header>

    <section :ref="(el) => (sectionEls.overview = el as HTMLElement)" class="section">
      <h3>{{ t('plugins.panel.sections.overview') }}</h3>
      <p v-if="item.description" class="desc">{{ item.description }}</p>
      <dl class="facts">
        <dt>{{ t('plugins.panel.status') }}</dt>
        <dd v-if="item.installed"><span class="pill" :class="status.cls"><span class="dot" />{{ status.text }}</span></dd>
        <dd v-else><span class="pill idle"><span class="dot" />{{ t('market.notInstalled') }}</span></dd>
        <template v-if="item.market">
          <dt>{{ t('market.publisherLabel') }}</dt>
          <dd>
            {{ item.market.publisher ?? t('market.noPublisher') }}
            <span v-if="item.market.official" class="badge official">{{ t('market.official') }}</span>
            <span v-if="item.market.trusted" class="badge trusted" :title="t('market.trustedHint')">{{ t('market.trusted') }}</span>
            <span v-if="item.market.curated" class="badge curated">{{ t('market.curated') }}</span>
          </dd>
          <template v-if="item.market.downloads !== undefined">
            <dt>{{ t('market.sort.downloads') }}</dt><dd>{{ t('market.downloads', { n: item.market.downloads }) }}</dd>
          </template>
          <template v-if="item.market.license">
            <dt>{{ t('market.license') }}</dt><dd>{{ item.market.license }}</dd>
          </template>
          <template v-if="item.market.platforms?.length">
            <dt>{{ t('market.platforms') }}</dt><dd>{{ item.market.platforms.join(', ') }}</dd>
          </template>
        </template>
        <dt v-if="item.installed">{{ t('plugins.panel.source') }}</dt>
        <dd v-if="item.installed">
          <template v-if="item.entry?.local">
            {{ t('plugins.panel.localFolder') }}
            <span v-if="item.entry.path" class="mono path">{{ item.entry.path }}</span>
          </template>
          <template v-else>{{ t('plugins.panel.npm') }}</template>
        </dd>
        <dt>{{ t('plugins.panel.package') }}</dt>
        <dd class="mono">{{ item.package }}</dd>
        <template v-if="item.version">
          <dt>{{ t('plugins.panel.version') }}</dt>
          <dd class="mono">{{ item.version }}</dd>
        </template>
      </dl>
      <p v-if="item.deps?.mushin && !item.deps.mushin.ok" class="note bad">{{ t('plugins.mushinVersion', { range: item.deps.mushin.range, version: item.deps.mushin.version }) }}</p>
      <div v-if="item.error" class="error">
        <strong>{{ t('plugins.panel.error') }}</strong>
        <pre class="mono">{{ item.error }}</pre>
      </div>
      <p v-if="app?.id && item.status === 'failed' && !item.version" class="note bad">{{ t('plugins.notInstalledEntry') }}</p>
      <p v-if="item.essential" class="note">{{ t('plugins.panel.essential') }}</p>
      <p v-if="item.kind === 'bot' && item.chat && !item.enabled" class="note">{{ t('plugins.panel.projectOff') }}</p>
    </section>

    <section v-if="sections.includes('usage')" :ref="(el) => (sectionEls.usage = el as HTMLElement)" class="section">
      <h3>{{ t('plugins.panel.sections.usage') }}</h3>
      <div v-if="chatBots.length" class="group">
        <h4>{{ item.kind === 'bot' ? t('plugins.panel.bots') : t('plugins.panel.chatBots') }}</h4>
        <div class="links">
          <RouterLink v-for="id in chatBots" :key="id" :to="`/bots/${id}/plugins`" class="link"><span class="i-lucide-bot" />{{ botName(id) }}</RouterLink>
        </div>
      </div>
      <div v-if="adapterBots.length" class="group">
        <h4>{{ t('plugins.panel.adapterBots') }}</h4>
        <div class="links">
          <RouterLink v-for="bot in adapterBots" :key="bot.id" :to="`/bots/${bot.id}/connection`" class="link"><span class="i-lucide-bot" />{{ bot.name }}</RouterLink>
        </div>
      </div>
      <div v-if="ownFlows.length" class="group">
        <h4>{{ t('plugins.panel.flows') }}</h4>
        <div class="links">
          <RouterLink v-for="flow in ownFlows" :key="flow.id" :to="`/flows/${flow.id}`" class="link"><span class="i-lucide-workflow" />{{ flow.name }}</RouterLink>
        </div>
      </div>
      <p v-if="unused" class="faint">{{ t('plugins.panel.noUsage') }}</p>
    </section>

    <section v-if="sections.includes('config')" :ref="(el) => (sectionEls.config = el as HTMLElement)" class="section">
      <h3>{{ t('plugins.panel.sections.config') }}</h3>
      <PluginConfig v-if="app" :plugin="app" @saved="emit('saved')" />
      <p v-else class="faint">{{ t('plugins.panel.perBot') }}</p>
    </section>

    <section :ref="(el) => (sectionEls.deps = el as HTMLElement)" class="section">
      <h3>{{ t('plugins.panel.sections.deps') }}</h3>
      <template v-for="list in [
        { key: 'requires', label: t('plugins.panel.requires'), deps: requires },
        { key: 'optional', label: t('plugins.panel.optional'), deps: optional },
      ]" :key="list.key">
        <div v-if="list.deps.length" class="group">
          <h4>
            {{ list.label }}
            <Button v-if="list.key === 'requires' && fixable" size="tiny" type="primary" secondary @click="emit('enableMissing')">{{ t('plugins.enableDeps') }}</Button>
          </h4>
          <ul class="deps">
            <li v-for="dep in list.deps" :key="dep.package" class="dep">
              <button type="button" class="dep-name" @click="emit('select', dep.package)" @mouseenter="emit('hoverDep', dep.package)" @mouseleave="emit('hoverDep', undefined)">{{ nameOf(dep.package) }}</button>
              <span class="mono range">{{ dep.range }}</span>
              <span class="pill" :class="depState(dep).cls"><span class="dot" />{{ depState(dep).text }}</span>
            </li>
          </ul>
        </div>
      </template>
      <template v-for="list in [
        { key: 'needed', label: t('plugins.panel.dependents'), deps: needed },
        { key: 'usedBy', label: t('plugins.panel.dependentsOptional'), deps: usedBy },
      ]" :key="list.key">
        <div v-if="list.deps.length" class="group">
          <h4>{{ list.label }}</h4>
          <ul class="deps">
            <li v-for="dep in list.deps" :key="dep.package" class="dep">
              <button type="button" class="dep-name" @click="emit('select', dep.package)" @mouseenter="emit('hoverDep', dep.package)" @mouseleave="emit('hoverDep', undefined)">{{ nameOf(dep.package) }}</button>
              <span class="pill" :class="dep.enabled ? 'ok' : 'idle'"><span class="dot" />{{ dep.enabled ? t('plugins.panel.enabled') : t('plugins.notEnabled') }}</span>
            </li>
          </ul>
        </div>
      </template>
      <p v-if="noDeps" class="faint">{{ t('plugins.panel.noDeps') }}</p>
    </section>

    <section v-if="sections.includes('contents')" :ref="(el) => (sectionEls.contents = el as HTMLElement)" class="section">
      <h3>{{ t('plugins.panel.sections.contents') }}</h3>
      <div v-for="part in contents" :key="part.key" class="group">
        <h4><span :class="part.icon" class="kind-icon" />{{ t(`plugins.provides.${part.key}`, part.names.length) }}</h4>
        <div class="names">
          <span v-for="value in part.names" :key="value" class="mono chip">{{ value }}</span>
        </div>
      </div>
      <p v-if="!contents.length" class="faint">{{ item.enabled ? t('plugins.panel.noContents') : t('plugins.panel.notRunning') }}</p>
    </section>

    <section v-if="sections.includes('logs')" :ref="(el) => (sectionEls.logs = el as HTMLElement)" class="section">
      <h3>{{ t('plugins.panel.sections.logs') }}</h3>
      <ul v-if="logs?.length" class="log-lines mono">
        <li v-for="line in logs" :key="line.sn" :class="`lv-${line.type}`">
          <span class="log-time">{{ clock(line.ts) }}</span>
          <span class="log-level">{{ line.type[0]?.toUpperCase() }}</span>
          <span class="log-text">{{ line.text }}</span>
        </li>
      </ul>
      <p v-else-if="logs" class="faint">{{ t('plugins.panel.logsEmpty') }}</p>
      <RouterLink :to="{ path: '/logs', query: { plugin: item.package } }" class="link">{{ t('plugins.panel.logsAll') }} →</RouterLink>
    </section>

    <section v-if="sections.includes('readme')" :ref="(el) => (sectionEls.readme = el as HTMLElement)" class="section">
      <h3>{{ t('plugins.panel.sections.readme') }}</h3>
      <div v-if="item.market" class="links">
        <a :href="`https://www.npmjs.com/package/${item.package}`" target="_blank" rel="noopener" class="link">{{ t('market.npm') }}</a>
        <a v-if="item.market.repository" :href="item.market.repository" target="_blank" rel="noopener" class="link">{{ t('market.repository') }}</a>
        <a v-if="item.market.homepage" :href="item.market.homepage" target="_blank" rel="noopener" class="link">{{ t('market.homepage') }}</a>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -- markdown-it with html off: raw HTML in a README is escaped. -->
      <div v-if="readme" class="readme" v-html="readme" />
      <p v-else-if="!detailLoading" class="faint">{{ t('market.noReadme') }}</p>
      <template v-if="detail?.versions?.length">
        <h4>{{ t('market.versions') }}</h4>
        <ul class="versions">
          <li v-for="version in detail.versions.slice(0, 12)" :key="version.version">
            <span class="mono">{{ version.version }}</span>
            <span class="faint-inline">{{ dateText(version.time) }}</span>
            <span v-if="version.deprecated" class="pill warn">{{ t('market.deprecated') }}</span>
            <span v-else-if="version.version === marketChoice?.version" class="pill ok"><span class="dot" />{{ t('market.versionRuns') }}</span>
            <span v-else-if="version.mushin" class="faint-inline">{{ t('market.versionNeeds', { range: version.mushin }) }}</span>
          </li>
        </ul>
      </template>
    </section>

    <section :ref="(el) => (sectionEls.updates = el as HTMLElement)" class="section last">
      <h3>{{ t('plugins.panel.sections.updates') }}</h3>
      <template v-if="!item.installed && item.market">
        <dl class="facts">
          <dt>{{ t('updates.available') }}</dt><dd class="mono">{{ item.market.version }}</dd>
          <dt>{{ t('updates.compatibility') }}</dt>
          <dd :class="marketChoice?.version ? 'ok-text' : 'bad-text'">{{ marketChoice?.version ? t('market.willInstall', { version: marketChoice.version }) : t('market.needs', { range: marketChoice?.needs }) }}</dd>
          <template v-if="item.market.updatedAt">
            <dt>{{ t('market.sort.updated') }}</dt><dd>{{ dateText(item.market.updatedAt) }}</dd>
          </template>
        </dl>
        <p v-if="detail?.brings?.length" class="note">{{ t('market.brings') }} {{ detail.brings.map((dep) => dep.inMarket ? dep.name : t('market.bringsMissing', { name: dep.name })).join(t('plugins.listSeparator')) }}</p>
      </template>
      <p v-else-if="updateInfo?.mode === 'development'" class="faint">{{ t('updates.development') }}</p>
      <template v-else-if="official">
        <dl class="facts">
          <dt>{{ t('updates.current') }}</dt><dd class="mono">{{ item.version ?? updateInfo?.version ?? '—' }}</dd>
        </dl>
        <p class="note">{{ t('updates.official') }}</p>
        <div v-if="updateInfo?.mushin?.available" class="update-row">
          <span>{{ t('updates.mushinAvailable', { version: updateInfo.mushin.available }) }}</span>
          <a :href="updateInfo.mushin.notesUrl" target="_blank" rel="noopener" class="link">{{ t('updates.notes') }}</a>
          <Tooltip :disabled="updateInfo.supervised" :max-width="320">
            <template #trigger><span><Button size="small" type="primary" :disabled="!updateInfo.supervised" @click="emit('update', ['mushin'])">{{ t('updates.apply') }}</Button></span></template>
            {{ t('updates.needsSupervisor') }}
          </Tooltip>
        </div>
        <p v-else class="faint">{{ t('updates.upToDate') }}</p>
      </template>
      <p v-else-if="item.entry?.local" class="faint">{{ t('updates.local') }}</p>
      <template v-else-if="update">
        <dl class="facts">
          <dt>{{ t('updates.current') }}</dt><dd class="mono">{{ update.current }}</dd>
          <dt>{{ t('updates.available') }}</dt><dd class="mono">{{ update.available ?? t('updates.upToDate') }}</dd>
          <template v-if="update.available">
            <dt>{{ t('updates.compatibility') }}</dt>
            <dd :class="update.compatible ? 'ok-text' : 'bad-text'">{{ update.compatible ? t('updates.compatible') : t('updates.incompatible', { range: update.requires }) }}</dd>
          </template>
        </dl>
        <div v-if="update.available" class="update-row">
          <a :href="`https://www.npmjs.com/package/${item.package}/v/${update.available}`" target="_blank" rel="noopener" class="link">{{ t('updates.npmPage') }}</a>
          <Tooltip :disabled="!!updateInfo?.supervised && update.compatible" :max-width="320">
            <template #trigger>
              <span><Button size="small" type="primary" :disabled="!updateInfo?.supervised || !update.compatible" @click="emit('update', [item.package])">{{ t('updates.update') }}</Button></span>
            </template>
            {{ !updateInfo?.supervised ? t('updates.needsSupervisor') : t('updates.incompatible', { range: update.requires }) }}
          </Tooltip>
        </div>
        <p v-if="update.error" class="faint">{{ t('updates.checkFailed', { error: update.error }) }}</p>
      </template>
      <p v-else class="faint">{{ t('updates.noInfo') }}</p>
      <p class="keys">{{ t('plugins.panel.keys') }}</p>
    </section>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
}

.head {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--s1);
  border-bottom: 1px solid var(--line);
}

.head-main {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 12px 8px 20px;
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

.head-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.name {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub {
  font-size: 11.5px;
  color: var(--fg3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toggle-wrap {
  display: inline-flex;
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 0 14px;
  overflow-x: auto;
}

.tab {
  flex: none;
  padding: 8px 8px 9px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--fg2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.tab:hover {
  color: var(--fg);
}

.tab.on {
  color: var(--primary);
  border-bottom-color: var(--primary);
}

.tab:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}

.section {
  padding: 18px 20px 6px;
}

.section + .section {
  border-top: 1px solid var(--line);
}

/* Room for the last section to scroll to the top. */
.section.last {
  min-height: 60vh;
}

h3 {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg2);
}

h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg3);
}

.desc {
  margin: 0 0 12px;
  font-size: 13.5px;
  line-height: 1.6;
}

.facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 6px 16px;
  margin: 0 0 12px;
  font-size: 13px;
}

.facts dt {
  color: var(--fg3);
}

.facts dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.path {
  display: block;
  font-size: 12px;
  color: var(--fg2);
}

.note {
  margin: 0 0 10px;
  font-size: 12.5px;
  color: var(--fg2);
}

.note.bad {
  color: var(--bad);
}

.error {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bad-soft);
  color: var(--bad);
  font-size: 12.5px;
}

.error pre {
  margin: 6px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
}

.group {
  margin-bottom: 14px;
}

.links,
.names {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 14px;
  color: var(--fg);
  font-size: 13px;
  text-decoration: none;
}

.link:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.deps {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.dep {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 2px 10px;
}

.dep + .dep {
  border-top: 1px solid var(--line);
}

.dep-name {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.dep-name:hover {
  color: var(--primary);
  text-decoration: underline;
}

.range {
  font-size: 11.5px;
  color: var(--fg3);
}

.chip {
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--s2);
  font-size: 12px;
}

.kind-icon {
  font-size: 13px;
}

.faint {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--fg3);
}

.update-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-bottom: 12px;
  font-size: 13px;
}

.link {
  color: var(--primary);
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}

.ok-text { color: var(--ok); }
.bad-text { color: var(--bad); }

.badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 11px;
  background: var(--s2);
  color: var(--fg2);
}

.badge.official { background: var(--primary-soft); color: var(--primary); }
.badge.trusted { background: var(--ok-soft); color: var(--ok); }
.badge.curated { background: var(--warn-soft); color: var(--warn); }

.log-lines {
  margin: 0 0 10px;
  padding: 8px 10px;
  list-style: none;
  max-height: 260px;
  overflow: auto;
  border-radius: 8px;
  background: var(--s2);
  font-size: 11.5px;
  line-height: 1.6;
}

.log-lines li {
  display: flex;
  gap: 8px;
}

.log-time,
.log-level {
  flex: none;
  color: var(--fg3);
}

.log-text {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.lv-warn .log-level,
.lv-warn .log-text { color: var(--warn); }
.lv-error .log-level,
.lv-error .log-text { color: var(--bad); }

.readme {
  margin: 10px 0 14px;
  font-size: 13.5px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.readme :deep(h1),
.readme :deep(h2),
.readme :deep(h3) {
  margin: 14px 0 6px;
  font-size: 15px;
}

.readme :deep(pre) {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--s2);
  overflow: auto;
  font-size: 12px;
}

.readme :deep(code) {
  font-family: var(--mono);
  font-size: 12px;
}

.readme :deep(img) {
  max-width: 100%;
}

.readme :deep(a) {
  color: var(--primary);
}

.versions {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12.5px;
}

.versions li {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 28px;
}

.faint-inline {
  color: var(--fg3);
  font-size: 12px;
}

.keys {
  margin: 24px 0 0;
  font-size: 12px;
  color: var(--fg3);
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
  border-radius: 50%;
  background: currentColor;
}

.pill.ok { color: var(--ok); background: var(--ok-soft); }
.pill.warn { color: var(--warn); background: var(--warn-soft); }
.pill.bad { color: var(--bad); background: var(--bad-soft); }
.pill.idle { color: var(--fg2); background: var(--s2); }
</style>
