<script setup lang="ts">
import {
  ChatbubblesOutline, ChevronBackOutline, ChevronForwardOutline, ServerOutline, DocumentTextOutline, GridOutline, ExtensionPuzzleOutline, GitNetworkOutline, KeyOutline,
  LanguageOutline, LibraryOutline, LogOutOutline, MoonOutline, PersonCircleOutline, PersonOutline, RocketOutline, SettingsOutline, SparklesOutline, SunnyOutline,
} from '@vicons/ionicons5'
import {
  type DropdownOption, type MenuOption, NButton, NDrawer, NDropdown, NIcon, NLayout, NLayoutHeader, NLayoutSider, NMenu, NTooltip,
} from 'naive-ui'
import { type Component, computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { connection, logout } from '../api'
import { setLocale } from '../i18n'
import { prefs } from '../prefs'
import { useAgentStore } from '../stores/agent'
import { useAgentSceneStore } from '../stores/agentScene'
import { useDataStore } from '../stores/data'
import { useRunsStore } from '../stores/runs'
import { themeMode, useTheme } from '../theme'
import AgentDock from './AgentDock.vue'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const data = useDataStore()
const agent = useAgentStore()
const agentScene = useAgentSceneStore()
const runs = useRunsStore()
const { isDark } = useTheme()

const width = ref(window.innerWidth)
const onResize = () => (width.value = window.innerWidth)
onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => window.removeEventListener('resize', onResize))
const narrow = computed(() => width.value < 1100)
const collapsed = ref(window.innerWidth < 800)
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

// First visit with nothing configured: start at the setup page.
let checkedSetup = false
watch(() => data.loadedProviders, (loaded) => {
  if (!loaded || checkedSetup) return
  checkedSetup = true
  if (!data.providers.length && route.path !== '/setup') router.replace('/setup')
}, { immediate: true })

const icon = (component: Component) => () => h(NIcon, null, { default: () => h(component) })
const link = (to: string, label: string) => () => h(RouterLink, { to }, { default: () => label })

// The menu is grouped by what each page is for: building bots, the resources they use, and the system.
// Pages that Settings → Features can hide are filtered out by key.
interface Page { key: string, label: string, icon: Component }
const groups = computed<{ key: string, label?: string, pages: Page[] }[]>(() => [
  { key: 'home', pages: [{ key: '/overview', label: t('nav.overview'), icon: GridOutline }] },
  {
    key: 'build',
    label: t('nav.groupBuild'),
    pages: [
      { key: '/bots', label: t('nav.bots'), icon: ChatbubblesOutline },
      { key: '/flows', label: t('nav.flows'), icon: GitNetworkOutline },
      { key: '/personas', label: t('nav.personas'), icon: PersonCircleOutline },
      { key: '/knowledge', label: t('nav.knowledge'), icon: LibraryOutline },
    ],
  },
  {
    key: 'resources',
    label: t('nav.groupResources'),
    pages: [
      { key: '/providers', label: t('nav.providers'), icon: KeyOutline },
      { key: '/plugins', label: t('nav.plugins'), icon: ExtensionPuzzleOutline },
    ],
  },
  {
    key: 'system',
    label: t('nav.groupSystem'),
    pages: [
      { key: '/logs', label: t('nav.logs'), icon: DocumentTextOutline },
      { key: '/database', label: t('nav.database'), icon: ServerOutline },
      { key: '/settings', label: t('nav.settings'), icon: SettingsOutline },
    ],
  },
])

const visible = (page: Page) => page.key === '/settings' || !prefs.hiddenPages.includes(page.key.slice(1))
const item = (page: Page): MenuOption => ({ key: page.key, label: link(page.key, page.label), icon: icon(page.icon) })

const menu = computed<MenuOption[]>(() => {
  const options: MenuOption[] = !data.ready ? [{ key: '/setup', label: link('/setup', t('nav.setup')), icon: icon(RocketOutline) }] : []
  for (const group of groups.value) {
    const pages = group.pages.filter(visible)
    if (!pages.length) continue
    // Collapsed, the group titles have no room; the items stay in the same order.
    if (!group.label || collapsed.value) options.push(...pages.map(item))
    else options.push({ type: 'group', key: group.key, label: group.label, children: pages.map(item) })
  }
  return options
})

// The top bar names where you are: the page, and on a bot's pages the bot.
const crumbs = computed(() => {
  const key = '/' + (route.path.split('/')[1] ?? '')
  const page = groups.value.flatMap((group) => group.pages).find((entry) => entry.key === key)
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
const logoFailed = ref(false)

// Language, theme and signing out live in one menu behind the account button.
const accountMenu = computed<DropdownOption[]>(() => [
  { key: 'locale', label: t('layout.language'), icon: icon(LanguageOutline) },
  { key: 'theme', label: isDark.value ? t('layout.lightTheme') : t('layout.darkTheme'), icon: icon(isDark.value ? SunnyOutline : MoonOutline) },
  { key: 'divider', type: 'divider' },
  { key: 'signOut', label: t('layout.signOut'), icon: icon(LogOutOutline) },
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
  <NLayout has-sider position="absolute">
    <NLayoutSider
      bordered
      collapse-mode="width"
      :collapsed-width="64"
      :width="224"
      :collapsed="collapsed"
      content-style="display: flex; flex-direction: column; height: 100%;"
    >
      <div class="brand" :class="{ collapsed }">
        <img v-if="!logoFailed" src="/logo.png" alt="" class="brand-logo" @error="logoFailed = true">
        <span v-if="!collapsed" class="brand-name">Mushin.js <span class="brand-kanji">無心</span></span>
      </div>
      <nav class="nav" :aria-label="t('layout.mainNav')">
        <NMenu :value="activeKey" :options="menu" :collapsed="collapsed" :collapsed-width="64" :icon-size="18" :root-indent="18" :indent="0" />
      </nav>
      <div class="side-foot" :class="{ collapsed }">
        <span v-if="!collapsed" class="link-state" :class="{ off: !connection.connected }">
          <span class="dot" />
          {{ connection.connected ? t('layout.connected') : t('layout.reconnecting') }}
        </span>
        <NTooltip :disabled="!collapsed" placement="right">
          <template #trigger>
            <NButton quaternary circle size="small" :aria-label="collapsed ? t('layout.expand') : t('layout.collapse')" @click="collapsed = !collapsed">
              <template #icon><NIcon><ChevronForwardOutline v-if="collapsed" /><ChevronBackOutline v-else /></NIcon></template>
            </NButton>
          </template>
          {{ t('layout.expand') }}
        </NTooltip>
      </div>
    </NLayoutSider>

    <NLayout content-style="display: flex; flex-direction: column; height: 100%;">
      <NLayoutHeader bordered class="topbar">
        <nav class="crumbs" :aria-label="t('layout.breadcrumb')">
          <template v-for="(crumb, index) in crumbs" :key="index">
            <span v-if="index" class="sep" aria-hidden="true">/</span>
            <RouterLink v-if="crumb.to" :to="crumb.to" class="crumb">{{ crumb.label }}</RouterLink>
            <span v-else class="crumb current" aria-current="page">{{ crumb.label }}</span>
          </template>
        </nav>
        <span v-if="!connection.connected" class="offline">{{ t('layout.reconnecting') }}</span>
        <NButton :type="agent.open ? 'primary' : 'default'" :secondary="agent.open" data-agent-target="agent.toggle" @click="agent.open = !agent.open">
          <template #icon><NIcon><SparklesOutline /></NIcon></template>
          {{ t('nav.agent') }}
        </NButton>
        <NDropdown trigger="click" placement="bottom-end" :options="accountMenu" @select="onAccount">
          <button type="button" class="account" :aria-label="t('layout.account')" :title="t('layout.account')">
            <NIcon :size="18"><PersonOutline /></NIcon>
          </button>
        </NDropdown>
      </NLayoutHeader>

      <div class="body">
        <main class="content">
          <RouterView />
        </main>
        <aside v-if="agent.open && !narrow" class="dock">
          <AgentDock />
        </aside>
      </div>
    </NLayout>

    <NDrawer v-if="narrow" v-model:show="agent.open" :width="Math.min(420, width)" placement="right">
      <AgentDock closable @close="agent.open = false" />
    </NDrawer>
  </NLayout>
</template>

<style scoped>
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 56px;
  flex: none;
  padding: 0 18px;
  overflow: hidden;
  white-space: nowrap;
}

.brand.collapsed {
  justify-content: center;
  padding: 0;
}

.brand-logo {
  width: 28px;
  height: 28px;
  flex: none;
}

.brand-name {
  font-weight: 650;
  font-size: 15px;
}

.brand-kanji {
  font-weight: 400;
  color: var(--fg3);
  margin-left: 2px;
}

.nav {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-bottom: 8px;
}

/* Group titles are small and quiet, so the items carry the menu. */
.nav :deep(.n-menu-item-group-title) {
  font-size: 12px;
  letter-spacing: 0.06em;
  padding-top: 10px;
}

.nav :deep(.n-menu-item-content--selected .n-menu-item-content-header) {
  font-weight: 600;
}

.nav :deep(a) {
  color: inherit;
  text-decoration: none;
}

.side-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 10px 0 18px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--fg3);
}

.side-foot.collapsed {
  justify-content: center;
  padding: 0;
}

.link-state {
  flex: 1;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  overflow: hidden;
}

.link-state .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--ok);
}

.link-state.off .dot {
  background: var(--bad);
}

.topbar {
  height: 56px;
  flex: none;
  display: flex;
  align-items: center;
  padding: 0 16px 0 24px;
  gap: 10px;
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
  width: 400px;
  flex: none;
  border-left: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--s1);
}
</style>
