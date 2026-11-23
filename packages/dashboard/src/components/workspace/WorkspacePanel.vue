<script setup lang="ts">
import { Button, Dropdown, type DropdownOption, Input, Tooltip } from '@mushinjs/ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { type PanelView, workspace } from '../../stores/workspace'
import BrowserView from './BrowserView.vue'
import StatusView from './StatusView.vue'
import TerminalView from './TerminalView.vue'

/**
 * The workspace's right panel: tabs that show the status of bots and plugins, dashboard pages (bot logs, a flow,
 * the database, …) and web pages. Fairy opens tabs here with ui.panel; you open them from the + menu.
 */
const emit = defineEmits<{ close: [] }>()

const { t, te } = useI18n()
const layout = workspace.layout

const active = computed(() => layout.views.find((view) => view.id === layout.activeView) ?? layout.views[0])

/** A page's name from its first path segment, e.g. `/bots/abc/logs` → Bots. */
function titleOf(view: PanelView) {
  if (view.title) return view.title
  if (view.kind === 'status') return t('workspace.panel.status')
  if (view.kind === 'terminal') return t('workspace.panel.terminal')
  if (view.kind === 'browser') return t('workspace.panel.browser')
  if (view.kind === 'web') {
    try {
      return new URL(view.url!).host
    } catch {
      return view.url!
    }
  }
  const first = view.path!.split(/[/?#]/)[1] ?? ''
  return te(`nav.${first}`) ? t(`nav.${first}`) : view.path!
}

const ICONS: Record<PanelView['kind'], string> = { status: 'i-lucide-activity', terminal: 'i-lucide-square-terminal', browser: 'i-lucide-compass', web: 'i-lucide-globe', page: 'i-lucide-app-window' }
const iconOf = (view: PanelView) => ICONS[view.kind]

const PAGES = ['/overview', '/bots', '/flows', '/plugins', '/providers', '/logs', '/database', '/knowledge', '/personas', '/settings']
const addMenu = computed<DropdownOption[]>(() => [
  { key: 'status', label: t('workspace.panel.status'), icon: 'i-lucide-activity' },
  { key: 'terminal', label: t('workspace.panel.terminal'), icon: 'i-lucide-square-terminal' },
  { key: 'browser', label: t('workspace.panel.browser'), icon: 'i-lucide-compass' },
  { key: 'web', label: t('workspace.panel.web'), icon: 'i-lucide-globe' },
  { type: 'group', label: t('workspace.panel.pages'), children: PAGES.map((path) => ({ key: path, label: t(`nav.${path.slice(1)}`), icon: 'i-lucide-app-window' })) },
])

const askingUrl = ref(false)
const url = ref('')

function onAdd(key: string) {
  if (key === 'status' || key === 'terminal' || key === 'browser') workspace.openView({ kind: key })
  else if (key === 'web') {
    url.value = ''
    askingUrl.value = true
  } else workspace.openView({ kind: 'page', path: key })
}

function openUrl() {
  let value = url.value.trim()
  if (!value) return
  if (!/^https?:\/\//.test(value)) value = `https://${value}`
  askingUrl.value = false
  workspace.openView({ kind: 'web', url: value })
}

// Pages are this dashboard in a frame; follow where they go so the tab and Fairy know the page.
const frames = new Map<string, HTMLIFrameElement>()
function onLoad(view: PanelView) {
  if (view.kind !== 'page') return
  try {
    const location = frames.get(view.id)?.contentWindow?.location
    if (location) view.path = `${location.pathname}${location.search}`
  } catch {}
}

function reload(view: PanelView) {
  const frame = frames.get(view.id)
  if (!frame) return
  try {
    frame.contentWindow?.location.reload()
  } catch {
    frame.src = frame.src
  }
}

const external = (view: PanelView) => (view.kind === 'web' ? view.url! : view.path!)
</script>

<template>
  <div class="panel">
    <div class="tabs" role="tablist">
      <div class="tab-list">
        <button
          v-for="view in layout.views"
          :key="view.id"
          type="button"
          role="tab"
          class="tab"
          :class="{ active: view.id === active?.id }"
          :aria-selected="view.id === active?.id"
          :title="view.kind === 'web' ? view.url : view.path"
          @click="layout.activeView = view.id"
          @auxclick.prevent="workspace.closeView(view.id)"
        >
          <span :class="iconOf(view)" class="tab-icon" />
          <span class="tab-title">{{ titleOf(view) }}</span>
          <span v-if="view.kind !== 'status'" class="i-lucide-x tab-close" role="button" :aria-label="t('workspace.panel.closeTab')" @click.stop="workspace.closeView(view.id)" />
        </button>
      </div>
      <Dropdown :options="addMenu" placement="bottom" align="end" @select="onAdd">
        <Button size="tiny" quaternary circle icon="i-lucide-plus" :aria-label="t('workspace.panel.add')" />
      </Dropdown>
      <Tooltip>
        <template #trigger><Button size="tiny" quaternary circle icon="i-lucide-panel-right-close" :aria-label="t('workspace.hidePanel')" @click="emit('close')" /></template>
        {{ t('workspace.hidePanel') }}
      </Tooltip>
    </div>

    <div v-if="askingUrl" class="address">
      <Input v-model:value="url" size="small" placeholder="https://" @keydown.enter.prevent="openUrl" @keydown.esc="askingUrl = false" />
      <Button size="small" type="primary" @click="openUrl">{{ t('workspace.panel.go') }}</Button>
      <Button size="small" quaternary @click="askingUrl = false">{{ t('common.cancel') }}</Button>
    </div>
    <div v-else-if="active && (active.kind === 'page' || active.kind === 'web')" class="address">
      <span class="address-text mono" :title="external(active)">{{ external(active) }}</span>
      <Button size="tiny" quaternary circle icon="i-lucide-rotate-cw" :aria-label="t('workspace.panel.reload')" @click="reload(active)" />
      <a :href="external(active)" target="_blank" rel="noopener" class="open-link" :aria-label="t('workspace.panel.openTab')" :title="t('workspace.panel.openTab')"><span class="i-lucide-external-link" /></a>
    </div>

    <div class="views">
      <template v-for="view in layout.views" :key="view.id">
        <div v-show="view.id === active?.id" class="view">
          <StatusView v-if="view.kind === 'status'" />
          <TerminalView v-else-if="view.kind === 'terminal'" />
          <BrowserView v-else-if="view.kind === 'browser'" :visible="view.id === active?.id" />
          <iframe
            v-else
            :ref="(el) => el && frames.set(view.id, el as HTMLIFrameElement)"
            :src="view.kind === 'web' ? view.url : view.path"
            :title="titleOf(view)"
            :sandbox="view.kind === 'web' ? 'allow-scripts allow-same-origin allow-forms allow-popups' : undefined"
            referrerpolicy="no-referrer"
            @load="onLoad(view)"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--s1);
}

.tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 44px;
  padding: 0 6px 0 4px;
  border-bottom: 1px solid var(--line);
}

.tab-list {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
}

.tab {
  flex: none;
  max-width: 180px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--fg2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.tab:hover {
  background: var(--s2);
}

.tab.active {
  background: var(--s2);
  color: var(--fg);
}

.tab-icon {
  flex: none;
}

.tab-title {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tab-close {
  flex: none;
  opacity: 0.5;
  font-size: 12px;
}

.tab-close:hover {
  opacity: 1;
}

.address {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
}

.address-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--fg2);
}

.open-link {
  display: inline-flex;
  padding: 4px;
  color: var(--fg2);
}

.views {
  flex: 1;
  min-height: 0;
  position: relative;
}

.view {
  position: absolute;
  inset: 0;
  overflow: auto;
}

iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: none;
  background: var(--bg);
}
</style>
