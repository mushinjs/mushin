<script setup lang="ts">
import { Button, Dropdown, type DropdownOption, Toggle, Tooltip } from '@mushinjs/ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { GROUP_ICONS, PANEL_SECTIONS, type PanelSection, type PluginItem } from '../../plugins/item'
import type { GroupKey } from '../../plugins/groups'
import type { AdapterType, Bot, DependencyState, FlowSummary } from '../../types'
import AdapterIcon from '../AdapterIcon.vue'
import PluginConfig from './PluginConfig.vue'

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
}>()

const { t } = useI18n()

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
  for (const section of PANEL_SECTIONS) {
    const el = sectionEls.value[section]
    if (el && el.offsetTop <= line) current = section
  }
  // At the bottom, the last sections may never reach the top.
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) {
    const last = PANEL_SECTIONS.findLast((section) => sectionEls.value[section])
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
const name = computed(() => props.item.name)

const menu = computed<DropdownOption[]>(() => [
  { key: 'reload', label: t('common.reload'), icon: 'i-lucide-refresh-cw', disabled: !app.value?.id || !props.item.enabled },
  ...(app.value?.id && !props.item.essential ? [{ type: 'divider' as const }, { key: 'remove', label: t('plugins.remove'), icon: 'i-lucide-trash-2', danger: true }] : []),
])

function onMenu(key: string) {
  if (key === 'reload') emit('reload')
  if (key === 'remove') emit('remove')
}

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
        <Tooltip v-if="item.kind === 'app' || item.chat" :max-width="320">
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
        <Dropdown v-if="item.kind === 'app'" :options="menu" align="end" @select="onMenu">
          <Button quaternary circle size="small" icon="i-lucide-ellipsis" :aria-label="t('plugins.panel.more')" />
        </Dropdown>
        <Button quaternary circle size="small" icon="i-lucide-x" :aria-label="t('common.close')" @click="emit('close')" />
      </div>
      <nav class="tabs" :aria-label="name">
        <button
          v-for="section in PANEL_SECTIONS"
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
        <dd><span class="pill" :class="status.cls"><span class="dot" />{{ status.text }}</span></dd>
        <dt>{{ t('plugins.panel.source') }}</dt>
        <dd>
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

    <section :ref="(el) => (sectionEls.usage = el as HTMLElement)" class="section">
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

    <section :ref="(el) => (sectionEls.config = el as HTMLElement)" class="section">
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

    <section :ref="(el) => (sectionEls.contents = el as HTMLElement)" class="section last">
      <h3>{{ t('plugins.panel.sections.contents') }}</h3>
      <div v-for="part in contents" :key="part.key" class="group">
        <h4><span :class="part.icon" class="kind-icon" />{{ t(`plugins.provides.${part.key}`, part.names.length) }}</h4>
        <div class="names">
          <span v-for="value in part.names" :key="value" class="mono chip">{{ value }}</span>
        </div>
      </div>
      <p v-if="!contents.length" class="faint">{{ item.enabled ? t('plugins.panel.noContents') : t('plugins.panel.notRunning') }}</p>
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
