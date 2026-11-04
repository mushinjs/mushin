<script setup lang="ts">
import { Button, Drawer, Dropdown, type DropdownOption } from '@mushin/ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { connection, logout } from '../api'
import { setLocale } from '../i18n'
import { clampFloat, clampWidth, DOCK_WIDTH, dockLayout, maxDockWidth } from '../agentDock'
import { prefs } from '../prefs'
import { useAgentStore } from '../stores/agent'
import { useAgentSceneStore } from '../stores/agentScene'
import { useDataStore } from '../stores/data'
import { useRunsStore } from '../stores/runs'
import { themeMode, useTheme } from '../theme'
import AgentDock from './AgentDock.vue'
import GlobalSearch from './GlobalSearch.vue'
import type { NavGroup, NavItem } from './nav'
import SideNav from './SideNav.vue'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const data = useDataStore()
const agent = useAgentStore()
const agentScene = useAgentSceneStore()
const runs = useRunsStore()
const { isDark } = useTheme()

const width = ref(window.innerWidth)
const onResize = () => {
  width.value = window.innerWidth
  if (dockLayout.mode === 'floating') Object.assign(dockLayout.float, clampFloat())
}
onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => window.removeEventListener('resize', onResize))
const narrow = computed(() => width.value < 1100)
// The sidebar remembers whether it was collapsed; on a narrow window it always starts collapsed.
const SIDEBAR_KEY = 'mushin.sidebar'
function readCollapsed() {
  if (window.innerWidth < 800) return true
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'collapsed'
  } catch {
    return false
  }
}
const collapsed = ref(readCollapsed())
watch(collapsed, (value) => {
  try {
    localStorage.setItem(SIDEBAR_KEY, value ? 'collapsed' : 'expanded')
  } catch {}
})
if (window.innerWidth < 1100) agent.open = false

data.bind()
agent.bind()
agentScene.bind()
runs.bind()
onMounted(() => {
  data.refreshProviders().catch(() => {})
  data.refreshBots().catch(() => {})
  agent.refreshSessions().catch(() => {})
  agent.refreshPickers().catch(() => {})
})

// ---- the Agent: docked at a width you drag, or floating where you put it ----

const dockWidth = computed(() => {
  void width.value
  return Math.min(dockLayout.width, maxDockWidth())
})
const floatStyle = computed(() => {
  void width.value
  const float = clampFloat()
  return { left: `${float.x}px`, top: `${float.y}px`, width: `${float.w}px`, height: `${float.h}px` }
})
const dragging = ref<'resize' | 'move' | 'size'>()

/** Follows the pointer until it is let go; `apply` gets how far it moved since it went down. */
function track(event: PointerEvent, kind: 'resize' | 'move' | 'size', apply: (dx: number, dy: number) => void) {
  event.preventDefault()
  const startX = event.clientX
  const startY = event.clientY
  // Only a real drag puts up the sheet, so a double-click still reaches the handle.
  const move = (next: PointerEvent) => {
    const dx = next.clientX - startX
    const dy = next.clientY - startY
    if (!dragging.value && Math.abs(dx) + Math.abs(dy) < 3) return
    dragging.value = kind
    apply(dx, dy)
  }
  const up = () => {
    dragging.value = undefined
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

function startResize(event: PointerEvent) {
  const start = dockWidth.value
  track(event, 'resize', (dx) => (dockLayout.width = clampWidth(start - dx)))
}

function nudgeWidth(event: KeyboardEvent) {
  const step = event.shiftKey ? 48 : 16
  if (event.key === 'ArrowLeft') dockLayout.width = clampWidth(dockWidth.value + step)
  else if (event.key === 'ArrowRight') dockLayout.width = clampWidth(dockWidth.value - step)
  else return
  event.preventDefault()
}

/** The floating window moves by its header, but not when a button or field in it is pressed. */
function startMove(event: PointerEvent) {
  const target = event.target as HTMLElement
  if (event.button !== 0 || !target.closest('.dock-head') || target.closest('button, a, input, textarea, [role="button"]')) return
  const start = clampFloat()
  track(event, 'move', (dx, dy) => Object.assign(dockLayout.float, clampFloat({ ...start, x: start.x + dx, y: start.y + dy })))
}

function startSize(event: PointerEvent) {
  const start = clampFloat()
  track(event, 'size', (dx, dy) => Object.assign(dockLayout.float, clampFloat({ ...start, w: start.w + dx, h: start.h + dy })))
}

function toggleDockMode() {
  if (dockLayout.mode === 'docked') {
    // Float where the dock was, at its width.
    const w = dockWidth.value
    Object.assign(dockLayout.float, clampFloat({ ...dockLayout.float, w, x: window.innerWidth - w - 24 }))
    dockLayout.mode = 'floating'
  } else {
    dockLayout.mode = 'docked'
  }
}

// ---- search: Ctrl+K (⌘K) anywhere ----

const searching = ref(false)
const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
function onSearchKey(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== 'k' || !(isMac ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return
  event.preventDefault()
  searching.value = !searching.value
}
onMounted(() => window.addEventListener('keydown', onSearchKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onSearchKey))

// First visit with nothing configured: start at the setup page.
let checkedSetup = false
watch(() => data.loadedProviders, (loaded) => {
  if (!loaded || checkedSetup) return
  checkedSetup = true
  if (!data.providers.length && route.path !== '/setup') router.replace('/setup')
}, { immediate: true })

// The menu is grouped by what each page is for: building bots, the resources they use, and the system.
const allGroups = computed<NavGroup[]>(() => [
  { key: 'home', items: [{ key: '/overview', label: t('nav.overview'), icon: 'i-lucide-layout-grid' }] },
  {
    key: 'build',
    label: t('nav.groupBuild'),
    items: [
      { key: '/bots', label: t('nav.bots'), icon: 'i-lucide-messages-square' },
      { key: '/flows', label: t('nav.flows'), icon: 'i-lucide-network' },
      { key: '/personas', label: t('nav.personas'), icon: 'i-lucide-circle-user' },
      { key: '/knowledge', label: t('nav.knowledge'), icon: 'i-lucide-library' },
    ],
  },
  {
    key: 'resources',
    label: t('nav.groupResources'),
    items: [
      { key: '/providers', label: t('nav.providers'), icon: 'i-lucide-key-round' },
      { key: '/plugins', label: t('nav.plugins'), icon: 'i-lucide-puzzle' },
    ],
  },
  {
    key: 'system',
    label: t('nav.groupSystem'),
    items: [
      { key: '/logs', label: t('nav.logs'), icon: 'i-lucide-file-text' },
      { key: '/database', label: t('nav.database'), icon: 'i-lucide-database' },
      { key: '/settings', label: t('nav.settings'), icon: 'i-lucide-settings' },
    ],
  },
])

// Pages that Settings → Features can hide are left out; quick setup shows until a provider exists.
const visible = (item: NavItem) => item.key === '/settings' || !prefs.hiddenPages.includes(item.key.slice(1))
const navGroups = computed<NavGroup[]>(() => {
  const groups = allGroups.value
    .map((group) => ({ ...group, items: group.items.filter(visible) }))
    .filter((group) => group.items.length)
  if (!data.ready) groups[0] = { ...groups[0], items: [{ key: '/setup', label: t('nav.setup'), icon: 'i-lucide-rocket' }, ...groups[0].items] }
  return groups
})

// The top bar names where you are: the page, and on a bot's pages the bot.
const crumbs = computed(() => {
  const key = '/' + (route.path.split('/')[1] ?? '')
  const page = allGroups.value.flatMap((group) => group.items).find((entry) => entry.key === key)
  const label = page?.label ?? (key === '/setup' ? t('nav.setup') : '')
  const list: { label: string, to?: string }[] = []
  if (!label) return list
  const id = route.params.id as string | undefined
  if (key === '/bots' && id) {
    list.push({ label, to: key })
    list.push({ label: data.bots.find((bot) => bot.id === id)?.name ?? id })
  } else {
    list.push({ label })
  }
  return list
})

const activeKey = computed(() => '/' + (route.path.split('/')[1] ?? ''))

// Language, theme and signing out live in one menu behind the account button.
const accountMenu = computed<DropdownOption[]>(() => [
  { key: 'locale', label: t('layout.language'), icon: 'i-lucide-languages' },
  { key: 'theme', label: isDark.value ? t('layout.lightTheme') : t('layout.darkTheme'), icon: isDark.value ? 'i-lucide-sun' : 'i-lucide-moon' },
  { key: 'divider', type: 'divider' },
  { key: 'signOut', label: t('layout.signOut'), icon: 'i-lucide-log-out' },
])

function onAccount(key: string) {
  if (key === 'locale') setLocale(locale.value.startsWith('zh') ? 'en' : 'zh-CN')
  else if (key === 'theme') themeMode.value = isDark.value ? 'light' : 'dark'
  else if (key === 'signOut') {
    logout()
    router.push('/login')
  }
}
</script>

<template>
  <div class="layout">
    <SideNav v-model:collapsed="collapsed" :groups="navGroups" :active="activeKey" />

    <div class="main">
      <header class="topbar">
        <nav class="crumbs" :aria-label="t('layout.breadcrumb')">
          <template v-for="(crumb, index) in crumbs" :key="index">
            <span v-if="index" class="sep" aria-hidden="true">/</span>
            <RouterLink v-if="crumb.to" :to="crumb.to" class="crumb">{{ crumb.label }}</RouterLink>
            <span v-else class="crumb current" aria-current="page">{{ crumb.label }}</span>
          </template>
        </nav>
        <span v-if="!connection.connected" class="offline">{{ t('layout.reconnecting') }}</span>
        <button type="button" class="search-button" :aria-label="t('search.title')" data-agent-target="search.open" @click="searching = true">
          <span class="i-lucide-search search-icon" />
          <span class="search-label">{{ t('search.button') }}</span>
          <span class="search-keys"><kbd>{{ isMac ? '⌘' : 'Ctrl' }}</kbd><kbd>K</kbd></span>
        </button>
        <Button
          :type="agent.open ? 'primary' : 'default'"
          :secondary="agent.open"
          icon="i-lucide-sparkles"
          data-agent-target="agent.toggle"
          :pressed="agent.open"
          @click="agent.open = !agent.open"
        >
          {{ t('nav.agent') }}
        </Button>
        <Dropdown placement="bottom" align="end" :options="accountMenu" @select="onAccount">
          <button type="button" class="account" :aria-label="t('layout.account')" :title="t('layout.account')">
            <span class="i-lucide-user account-icon" />
          </button>
        </Dropdown>
      </header>

      <div class="body">
        <main class="content">
          <RouterView />
        </main>
        <aside v-if="agent.open && !narrow && dockLayout.mode === 'docked'" class="dock" :style="{ width: `${dockWidth}px` }">
          <div
            class="dock-resizer"
            :class="{ active: dragging === 'resize' }"
            role="separator"
            aria-orientation="vertical"
            tabindex="0"
            :aria-label="t('agent.resize')"
            :aria-valuenow="dockWidth"
            :title="t('agent.resize')"
            @pointerdown="startResize"
            @dblclick="dockLayout.width = DOCK_WIDTH"
            @keydown="nudgeWidth"
          />
          <AgentDock mode="docked" @toggle-mode="toggleDockMode" />
        </aside>
      </div>
      <aside
        v-if="agent.open && !narrow && dockLayout.mode === 'floating'"
        class="dock floating"
        :class="{ moving: dragging === 'move' }"
        :style="floatStyle"
        @pointerdown="startMove"
      >
        <AgentDock mode="floating" closable @toggle-mode="toggleDockMode" @close="agent.open = false" />
        <div class="float-resizer" :title="t('agent.resizeFloat')" @pointerdown.stop="startSize" />
      </aside>
      <!-- While dragging, a sheet over the page keeps the pointer from selecting text or entering frames. -->
      <div v-if="dragging" class="drag-sheet" :class="dragging" />
    </div>

    <GlobalSearch v-model:show="searching" :pages="navGroups" />

    <Drawer v-if="narrow" v-model:show="agent.open" :width="Math.min(420, width)" :label="t('nav.agent')">
      <AgentDock closable @close="agent.open = false" />
    </Drawer>
  </div>
</template>

<style scoped>
.layout {
  position: absolute;
  inset: 0;
  display: flex;
  background: var(--bg);
  color: var(--fg);
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.topbar {
  height: 56px;
  flex: none;
  display: flex;
  align-items: center;
  padding: 0 16px 0 24px;
  gap: 10px;
  border-bottom: 1px solid var(--line);
  background: var(--s1);
}

.search-icon {
  font-size: 16px;
}

.account-icon {
  font-size: 18px;
}

.crumbs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  overflow: hidden;
  color: var(--fg2);
  font-size: 14px;
}

.crumb {
  color: var(--fg2);
  overflow: hidden;
  text-overflow: ellipsis;
}

a.crumb:hover {
  color: var(--fg);
  text-decoration: none;
}

.crumb.current {
  color: var(--fg);
  font-weight: 600;
}

.sep {
  color: var(--fg3);
}

.offline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 12px;
  white-space: nowrap;
  color: var(--bad);
  background: var(--bad-soft);
}

.search-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  min-width: 0;
  padding: 0 6px 0 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--s2);
  color: var(--fg3);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.search-button:hover {
  color: var(--fg2);
  border-color: color-mix(in srgb, var(--fg3) 50%, var(--line));
}

.search-button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.search-label {
  min-width: 96px;
  text-align: left;
}

.search-keys {
  display: inline-flex;
  gap: 3px;
}

.search-keys kbd {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--s1);
  color: var(--fg3);
  font: 11px/1 var(--mono);
}

/* On a small screen the search is an icon. */
@media (max-width: 700px) {
  .search-button {
    width: 34px;
    padding: 0;
    justify-content: center;
  }

  .search-label,
  .search-keys {
    display: none;
  }
}

.account {
  width: 34px;
  height: 34px;
  flex: none;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 50%;
  background: var(--primary-soft);
  color: var(--primary);
  cursor: pointer;
}

.account:hover {
  background: color-mix(in srgb, var(--primary) 22%, transparent);
}

.account:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.content {
  flex: 1;
  min-width: 0;
  overflow: auto;
  scrollbar-gutter: stable;
}

.dock {
  position: relative;
  flex: none;
  border-left: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--s1);
}

/* The left edge of the docked Agent: a thin line that thickens under the pointer. */
.dock-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -4px;
  z-index: 3;
  width: 8px;
  cursor: col-resize;
  touch-action: none;
}

.dock-resizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 2px;
  background: transparent;
  transition: background-color 0.15s;
}

.dock-resizer:hover::after,
.dock-resizer:focus-visible::after,
.dock-resizer.active::after {
  background: var(--primary);
}

.dock-resizer:focus-visible {
  outline: none;
}

.dock.floating {
  position: fixed;
  z-index: 60;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(10, 12, 30, 0.22), 0 2px 8px rgba(10, 12, 30, 0.12);
}

.floating :deep(.dock-head) {
  cursor: grab;
  user-select: none;
}

.floating.moving :deep(.dock-head) {
  cursor: grabbing;
}

/* The bottom-right corner of the floating Agent, drawn as two short diagonal lines. */
.float-resizer {
  position: absolute;
  right: 0;
  bottom: 0;
  z-index: 3;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  touch-action: none;
  background:
    linear-gradient(135deg, transparent 0 55%, var(--fg3) 55% 62%, transparent 62% 75%, var(--fg3) 75% 82%, transparent 82%);
  opacity: 0.6;
}

.float-resizer:hover {
  opacity: 1;
}

.drag-sheet {
  position: fixed;
  inset: 0;
  z-index: 70;
  cursor: col-resize;
}

.drag-sheet.move {
  cursor: grabbing;
}

.drag-sheet.size {
  cursor: nwse-resize;
}
</style>
