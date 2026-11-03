<script setup lang="ts">
import {
  ChatbubblesOutline, ServerOutline, DocumentTextOutline, GridOutline, ExtensionPuzzleOutline, GitNetworkOutline, KeyOutline,
  LanguageOutline, LibraryOutline, LogOutOutline, MoonOutline, PersonCircleOutline, PersonOutline, RocketOutline, SettingsOutline, SparklesOutline, SunnyOutline,
} from '@vicons/ionicons5'
import {
  type DropdownOption, NButton, NDrawer, NDropdown, NIcon, NLayout, NLayoutHeader,
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
const onResize = () => (width.value = window.innerWidth)
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

// First visit with nothing configured: start at the setup page.
let checkedSetup = false
watch(() => data.loadedProviders, (loaded) => {
  if (!loaded || checkedSetup) return
  checkedSetup = true
  if (!data.providers.length && route.path !== '/setup') router.replace('/setup')
}, { immediate: true })

const icon = (component: Component) => () => h(NIcon, null, { default: () => h(component) })

// The menu is grouped by what each page is for: building bots, the resources they use, and the system.
const allGroups = computed<NavGroup[]>(() => [
  { key: 'home', items: [{ key: '/overview', label: t('nav.overview'), icon: GridOutline }] },
  {
    key: 'build',
    label: t('nav.groupBuild'),
    items: [
      { key: '/bots', label: t('nav.bots'), icon: ChatbubblesOutline },
      { key: '/flows', label: t('nav.flows'), icon: GitNetworkOutline },
      { key: '/personas', label: t('nav.personas'), icon: PersonCircleOutline },
      { key: '/knowledge', label: t('nav.knowledge'), icon: LibraryOutline },
    ],
  },
  {
    key: 'resources',
    label: t('nav.groupResources'),
    items: [
      { key: '/providers', label: t('nav.providers'), icon: KeyOutline },
      { key: '/plugins', label: t('nav.plugins'), icon: ExtensionPuzzleOutline },
    ],
  },
  {
    key: 'system',
    label: t('nav.groupSystem'),
    items: [
      { key: '/logs', label: t('nav.logs'), icon: DocumentTextOutline },
      { key: '/database', label: t('nav.database'), icon: ServerOutline },
      { key: '/settings', label: t('nav.settings'), icon: SettingsOutline },
    ],
  },
])

// Pages that Settings → Features can hide are left out; quick setup shows until a provider exists.
const visible = (item: NavItem) => item.key === '/settings' || !prefs.hiddenPages.includes(item.key.slice(1))
const navGroups = computed<NavGroup[]>(() => {
  const groups = allGroups.value
    .map((group) => ({ ...group, items: group.items.filter(visible) }))
    .filter((group) => group.items.length)
  if (!data.ready) groups[0] = { ...groups[0], items: [{ key: '/setup', label: t('nav.setup'), icon: RocketOutline }, ...groups[0].items] }
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
    <SideNav v-model:collapsed="collapsed" :groups="navGroups" :active="activeKey" />

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
