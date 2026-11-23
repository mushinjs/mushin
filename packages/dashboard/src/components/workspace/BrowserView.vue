<script setup lang="ts">
import { Button, Input, Tooltip } from '@mushinjs/ui'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call, on } from '../../api'
import { workspace } from '../../stores/workspace'

/**
 * The panel's browser tab: the browser Fairy uses on this machine, as a picture of the current page that updates
 * after each step. Type an address to open a page, pick a tab, or click the picture to click the page. Needs the
 * Browser plugin.
 */
interface BrowserTab {
  id: string
  url: string
  title: string
  active: boolean
}

interface BrowserFrame {
  tab: string
  url: string
  title: string
  image: string
  width: number
  height: number
  tabs: BrowserTab[]
  at: number
}

const props = defineProps<{ visible?: boolean }>()
const { t } = useI18n()
const frame = ref<BrowserFrame | null>(null)
const available = ref(true)
const address = ref('')
/** While the address bar has focus, a new frame does not overwrite what is being typed. */
const typing = ref(false)
const busy = ref(false)
const error = ref('')

async function load() {
  try {
    frame.value = await call<BrowserFrame | null>('browser.frame')
    available.value = true
  } catch {
    available.value = false
  }
}

async function run(action: string, input: Record<string, unknown> = {}) {
  busy.value = true
  error.value = ''
  try {
    await call(action, input)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

function open() {
  const url = address.value.trim()
  if (!url) return
  typing.value = false
  ;(document.activeElement as HTMLElement | null)?.blur()
  run('browser.open', { url })
}

/** A click on the picture clicks the page at the same spot. */
function clickAt(event: MouseEvent) {
  const current = frame.value
  if (!current || busy.value) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * current.width
  const y = ((event.clientY - rect.top) / rect.height) * current.height
  run('browser.mouse', { x: Math.round(x), y: Math.round(y) })
}

let wheelAt = 0
function onWheel(event: WheelEvent) {
  if (!frame.value || Date.now() - wheelAt < 600) return
  wheelAt = Date.now()
  run('browser.scroll', { direction: event.deltaY > 0 ? 'down' : 'up' })
}

watch(frame, (value) => {
  if (!typing.value) address.value = value?.url && value.url !== 'about:blank' ? value.url : ''
})
watch(() => props.visible, (visible) => visible && load())

const offs: (() => void)[] = []
onMounted(() => {
  load()
  offs.push(on('browser/frame', (value: BrowserFrame) => {
    frame.value = value
    available.value = true
  }))
  offs.push(on('browser/closed', () => (frame.value = null)))
  offs.push(on('manager/changed', () => !available.value && load()))
})
onBeforeUnmount(() => offs.forEach((off) => off()))

const openPlugins = () => workspace.openView({ kind: 'page', path: '/plugins?highlight=%40mushinjs%2Fplugin-browser' })
</script>

<template>
  <div class="browser">
    <div v-if="!available" class="off">
      <span class="i-lucide-compass off-icon" />
      <p>{{ t('workspace.browser.unavailable') }}</p>
      <Button size="small" secondary @click="openPlugins">{{ t('workspace.browser.openPlugins') }}</Button>
    </div>
    <template v-else>
      <div v-if="frame && frame.tabs.length > 1" class="tabs" role="tablist">
        <div v-for="tab in frame.tabs" :key="tab.id" class="tab" :class="{ on: tab.active }">
          <button type="button" role="tab" class="tab-main" :aria-selected="tab.active" :title="`${tab.title}\n${tab.url}`" @click="run('browser.tab', { id: tab.id })">
            {{ tab.title || tab.url || t('workspace.browser.newTab') }}
          </button>
          <button type="button" class="tab-close i-lucide-x" :aria-label="t('workspace.browser.closeTab')" @click="run('browser.tab', { id: tab.id, close: true })" />
        </div>
      </div>
      <form class="bar" @submit.prevent="open">
        <Tooltip>
          <template #trigger><Button size="tiny" quaternary circle icon="i-lucide-arrow-left" :disabled="!frame || busy" :aria-label="t('workspace.browser.back')" @click="run('browser.back')" /></template>
          {{ t('workspace.browser.back') }}
        </Tooltip>
        <Input
          v-model:value="address"
          size="small"
          class="mono address"
          :placeholder="t('workspace.browser.address')"
          @focus="typing = true"
          @blur="typing = false"
        />
        <Tooltip>
          <template #trigger><Button size="tiny" quaternary circle icon="i-lucide-refresh-cw" :disabled="!frame" :loading="busy" :aria-label="t('workspace.browser.refresh')" @click="load" /></template>
          {{ t('workspace.browser.refresh') }}
        </Tooltip>
        <Tooltip>
          <template #trigger><Button size="tiny" quaternary circle icon="i-lucide-power" :disabled="!frame" :aria-label="t('workspace.browser.close')" @click="run('browser.close')" /></template>
          {{ t('workspace.browser.close') }}
        </Tooltip>
      </form>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="screen" :class="{ busy }">
        <img
          v-if="frame"
          :src="frame.image"
          :alt="frame.title"
          :title="t('workspace.browser.clickHint')"
          class="shot"
          @click="clickAt"
          @wheel.prevent="onWheel"
        >
        <div v-else class="idle">
          <span class="i-lucide-compass idle-icon" />
          <p>{{ t('workspace.browser.idle') }}</p>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.browser {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  font-size: 13px;
}

.off,
.idle {
  margin: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 340px;
  text-align: center;
  color: var(--fg2);
}

.off-icon,
.idle-icon {
  font-size: 28px;
  color: var(--fg3);
}

.idle p {
  margin: 0;
}

.tabs {
  flex: none;
  display: flex;
  gap: 4px;
  padding: 6px 8px 0;
  overflow-x: auto;
  border-bottom: 1px solid var(--line);
}

.tab {
  flex: none;
  display: flex;
  align-items: center;
  max-width: 180px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 7px 7px 0 0;
  color: var(--fg2);
}

.tab.on {
  border-color: var(--line);
  background: var(--s1);
  color: var(--fg);
}

.tab-main {
  min-width: 0;
  padding: 5px 4px 5px 10px;
  overflow: hidden;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: pointer;
}

.tab-close {
  flex: none;
  width: 18px;
  height: 18px;
  margin-right: 4px;
  border: none;
  color: var(--fg3);
  font-size: 12px;
  cursor: pointer;
}

.tab-close:hover {
  color: var(--fg);
}

.bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
}

.address {
  flex: 1;
  min-width: 0;
}

.error {
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
  color: var(--bad);
  font-size: 12px;
}

.screen {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: auto;
  background: var(--bg);
}

.screen.busy .shot {
  opacity: 0.85;
}

.shot {
  display: block;
  width: 100%;
  height: auto;
  align-self: flex-start;
  cursor: pointer;
  transition: opacity 0.15s;
}
</style>
