<script setup lang="ts">
import {
  ChatbubblesOutline, DocumentTextOutline, ExtensionPuzzleOutline, KeyOutline, LanguageOutline, LogOutOutline,
  MoonOutline, RocketOutline, SparklesOutline, SunnyOutline,
} from '@vicons/ionicons5'
import {
  type MenuOption, NButton, NDrawer, NIcon, NLayout, NLayoutHeader, NLayoutSider, NMenu, NTooltip,
} from 'naive-ui'
import { type Component, computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { connection, logout } from '../api'
import { setLocale } from '../i18n'
import { useAgentStore } from '../stores/agent'
import { useDataStore } from '../stores/data'
import { themeMode, useTheme } from '../theme'
import AgentDock from './AgentDock.vue'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const data = useDataStore()
const agent = useAgentStore()
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
onMounted(() => {
  data.refreshProviders().catch(() => {})
  data.refreshBots().catch(() => {})
  agent.refreshSessions().catch(() => {})
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

const menu = computed<MenuOption[]>(() => [
  ...(!data.ready ? [{ key: '/setup', label: link('/setup', t('nav.setup')), icon: icon(RocketOutline) }] : []),
  { key: '/bots', label: link('/bots', t('nav.bots')), icon: icon(ChatbubblesOutline) },
  { key: '/providers', label: link('/providers', t('nav.providers')), icon: icon(KeyOutline) },
  { key: '/plugins', label: link('/plugins', t('nav.plugins')), icon: icon(ExtensionPuzzleOutline) },
  { key: '/logs', label: link('/logs', t('nav.logs')), icon: icon(DocumentTextOutline) },
])

const activeKey = computed(() => '/' + (route.path.split('/')[1] ?? ''))
const logoFailed = ref(false)

function toggleTheme() {
  themeMode.value = isDark.value ? 'light' : 'dark'
}

function toggleLocale() {
  setLocale(locale.value.startsWith('zh') ? 'en' : 'zh-CN')
}

function signOut() {
  logout()
  router.push('/login')
}
</script>

<template>
  <NLayout has-sider position="absolute">
    <NLayoutSider
      bordered
      collapse-mode="width"
      :collapsed-width="64"
      :width="216"
      :collapsed="collapsed"
      show-trigger
      @collapse="collapsed = true"
      @expand="collapsed = false"
    >
      <div class="brand" :class="{ collapsed }">
        <img v-if="!logoFailed" src="/logo.png" alt="" class="brand-logo" @error="logoFailed = true">
        <span v-if="!collapsed" class="brand-name">Mushin.js <span class="brand-kanji">無心</span></span>
      </div>
      <NMenu :value="activeKey" :options="menu" :collapsed="collapsed" :collapsed-width="64" :icon-size="20" />
    </NLayoutSider>

    <NLayout content-style="display: flex; flex-direction: column; height: 100%;">
      <NLayoutHeader bordered class="topbar">
        <div class="topbar-left">
          <span v-if="!connection.connected" class="offline-dot">{{ t('layout.reconnecting') }}</span>
        </div>
        <div class="topbar-right">
          <NTooltip>
            <template #trigger>
              <NButton quaternary circle :aria-label="t('layout.language')" @click="toggleLocale">
                <template #icon><NIcon><LanguageOutline /></NIcon></template>
              </NButton>
            </template>
            {{ t('layout.language') }}
          </NTooltip>
          <NTooltip>
            <template #trigger>
              <NButton quaternary circle :aria-label="t('layout.theme')" @click="toggleTheme">
                <template #icon><NIcon><SunnyOutline v-if="isDark" /><MoonOutline v-else /></NIcon></template>
              </NButton>
            </template>
            {{ t('layout.theme') }}
          </NTooltip>
          <NTooltip>
            <template #trigger>
              <NButton quaternary circle :aria-label="t('layout.signOut')" @click="signOut">
                <template #icon><NIcon><LogOutOutline /></NIcon></template>
              </NButton>
            </template>
            {{ t('layout.signOut') }}
          </NTooltip>
          <NButton :type="agent.open ? 'primary' : 'default'" :secondary="agent.open" data-agent-target="agent.toggle" @click="agent.open = !agent.open">
            <template #icon><NIcon><SparklesOutline /></NIcon></template>
            {{ t('nav.agent') }}
          </NButton>
        </div>
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
  padding: 0 18px;
  overflow: hidden;
  white-space: nowrap;
}

.brand.collapsed {
  justify-content: center;
  padding: 0;
}

.brand-logo {
  width: 30px;
  height: 30px;
  flex: none;
}

.brand-name {
  font-weight: 650;
  font-size: 16px;
}

.brand-kanji {
  font-weight: 400;
  opacity: 0.55;
  margin-left: 2px;
}

.topbar {
  height: 56px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  gap: 8px;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.topbar-right > :last-child {
  margin-left: 8px;
}

.offline-dot {
  font-size: 12px;
  color: #d03050;
}

.offline-dot::before {
  content: '';
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d03050;
  margin-right: 6px;
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
}

.dock {
  width: 400px;
  flex: none;
  border-left: 1px solid rgba(127, 127, 127, 0.18);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
</style>
