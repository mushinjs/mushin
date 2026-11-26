<script setup lang="ts">
import { Button, Tooltip } from '@mushinjs/ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { connection, on } from '../api'
import FairyPane from '../components/workspace/FairyPane.vue'
import WorkspacePanel from '../components/workspace/WorkspacePanel.vue'
import WorkspaceSidebar from '../components/workspace/WorkspaceSidebar.vue'
import { useDataStore } from '../stores/data'
import { useFairyPane, useFairyStore } from '../stores/fairy'
import { ATTACH_MESSAGE, type PendingRef } from '../components/fairy/refs'
import { useFairyActivityStore } from '../stores/fairyActivity'
import { useFairySceneStore } from '../stores/fairyScene'
import { useRunsStore } from '../stores/runs'
import { LEFT_WIDTH, MIN_CENTER, MIN_SIDE, RIGHT_WIDTH, workspace } from '../stores/workspace'

/**
 * Fairy's workspace: conversations by group on the left, one or two conversations in the middle, and a panel on
 * the right for what Fairy or you open: pages, web pages, status. Both sides hide and resize.
 */
const { t } = useI18n()
const router = useRouter()
const layout = workspace.layout
const data = useDataStore()
const fairy = useFairyStore()
const scenes = useFairySceneStore()
const runs = useRunsStore()

data.bind()
fairy.bind()
scenes.bind()
runs.bind()
useFairyActivityStore().bind()
onMounted(() => {
  workspace.active = true
  data.refreshProviders().catch(() => {})
  data.refreshBots().catch(() => {})
  fairy.refreshSessions().catch(() => {})
  fairy.refreshPickers().catch(() => {})
})
onBeforeUnmount(() => {
  workspace.active = false
  scenes.publish(undefined)
})

// A command Fairy runs adds the terminal tab, and a page its browser shows adds the browser tab, without switching
// to them: a dot on the tab says there is something new. A tab you closed stays closed.
const offProcess = on('terminal/process', (info: { running: boolean; session?: string }) => {
  if (info.running && info.session) workspace.openView({ kind: 'terminal' }, { from: 'fairy' })
})
const offBrowser = on('browser/frame', () => {
  workspace.openView({ kind: 'browser' }, { from: 'fairy' })
})

/** Tabs with something new while the panel is folded away: a dot on the button that brings it back. */
const unseen = computed(() => !layout.rightOpen && layout.views.some((view) => view.unseen))
onBeforeUnmount(() => {
  offProcess()
  offBrowser()
})

// Fairy hears which panel tab is open, so "this page" means what the user sees beside the chat.
const activeView = computed(() => layout.views.find((view) => view.id === layout.activeView))
watch(() => [layout.rightOpen, activeView.value?.kind, activeView.value?.path, activeView.value?.url] as const, ([open, kind, path, url]) => {
  const shown = !open ? 'hidden' : kind === 'page' ? path : kind === 'web' ? url : kind
  scenes.publish({ state: { panel: shown ?? 'status', split: layout.split } })
}, { immediate: true })

// ---- widths ----

const width = ref(window.innerWidth)
const onResize = () => (width.value = window.innerWidth)
onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => window.removeEventListener('resize', onResize))

// A page in the panel gives something to Fairy (a quoted chat message, log lines): it goes to the conversation in focus.
function onPanelMessage(event: MessageEvent<{ type?: string; ref?: PendingRef }>) {
  if (event.origin !== location.origin || event.data?.type !== ATTACH_MESSAGE || !event.data.ref) return
  const conversation = layout.split ? useFairyPane(workspace.focused) : fairy
  conversation.attach(event.data.ref)
}
onMounted(() => window.addEventListener('message', onPanelMessage))
onBeforeUnmount(() => window.removeEventListener('message', onPanelMessage))

/** Sides as wide as they were left, but never squeezing the middle below its minimum. */
const sides = computed(() => {
  const room = width.value - MIN_CENTER * (layout.split ? 2 : 1)
  let left = layout.leftOpen ? layout.leftWidth : 0
  let right = layout.rightOpen ? layout.rightWidth : 0
  const over = left + right - room
  if (over > 0) {
    const cut = Math.min(over, Math.max(0, right - MIN_SIDE))
    right -= cut
    left -= Math.min(over - cut, Math.max(0, left - MIN_SIDE))
  }
  return { left, right }
})

const dragging = ref<'left' | 'right' | 'split'>()
const panes = ref<HTMLElement>()

function track(event: PointerEvent, kind: 'left' | 'right' | 'split', apply: (dx: number) => void) {
  event.preventDefault()
  const startX = event.clientX
  dragging.value = kind
  const move = (next: PointerEvent) => apply(next.clientX - startX)
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

const clampSide = (value: number) => Math.round(Math.min(Math.max(value, MIN_SIDE), Math.max(MIN_SIDE, width.value * 0.45)))

/**
 * Like VS Code: dragged half its minimum width past the minimum, a side folds away, and dragged back out (or out
 * from the window's edge while folded) it opens again, all within one drag.
 */
function resizeSide(event: PointerEvent, side: 'left' | 'right') {
  const start = side === 'left' ? sides.value.left : sides.value.right
  track(event, side, (dx) => {
    const wanted = start + (side === 'left' ? dx : -dx)
    const open = wanted >= MIN_SIDE / 2
    if (side === 'left') {
      layout.leftOpen = open
      if (open) layout.leftWidth = clampSide(wanted)
    } else {
      layout.rightOpen = open
      if (open) layout.rightWidth = clampSide(wanted)
    }
  })
}

function resizeSplit(event: PointerEvent) {
  const total = panes.value?.clientWidth ?? 1
  const start = layout.splitRatio
  track(event, 'split', (dx) => (layout.splitRatio = Math.min(0.8, Math.max(0.2, start + dx / total))))
}

function nudge(event: KeyboardEvent, side: 'left' | 'right') {
  const step = (event.shiftKey ? 48 : 16) * (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0)
  if (!step) return
  event.preventDefault()
  // Arrows past the minimum fold the side; the other way opens it at its minimum.
  const grow = side === 'left' ? step : -step
  const current = side === 'left' ? sides.value.left : sides.value.right
  const open = current > 0 ? current > MIN_SIDE || grow > 0 : grow > 0
  const next = current > 0 ? clampSide(current + grow) : MIN_SIDE
  if (side === 'left') [layout.leftOpen, layout.leftWidth] = [open, open ? next : layout.leftWidth]
  else [layout.rightOpen, layout.rightWidth] = [open, open ? next : layout.rightWidth]
}

function resetSide(side: 'left' | 'right') {
  if (side === 'left') [layout.leftOpen, layout.leftWidth] = [true, LEFT_WIDTH]
  else [layout.rightOpen, layout.rightWidth] = [true, RIGHT_WIDTH]
}

// ---- split view: drop a conversation from the list onto the middle ----

const draggingSession = ref<string>()
const overDrop = ref(false)

function onDrop(event: DragEvent) {
  const id = event.dataTransfer?.getData('application/x-fairy-session')
  overDrop.value = false
  draggingSession.value = undefined
  if (!id) return
  event.preventDefault()
  layout.split = true
  workspace.focused = 'split'
  useFairyPane('split').load(id).catch(() => {})
}

function closeSplit() {
  layout.split = false
  workspace.focused = 'main'
}

function toggleSplit() {
  if (layout.split) closeSplit()
  else {
    layout.split = true
    workspace.focused = 'split'
    const pane = useFairyPane('split')
    if (!pane.current) pane.newChat()
  }
}
</script>

<template>
  <div class="ws" :class="{ dragging: !!dragging }">
    <header class="ws-top">
      <Tooltip>
        <template #trigger>
          <Button size="small" quaternary circle :icon="layout.leftOpen ? 'i-lucide-panel-left-close' : 'i-lucide-panel-left-open'" :aria-label="t('workspace.toggleSessions')" :pressed="layout.leftOpen" @click="layout.leftOpen = !layout.leftOpen" />
        </template>
        {{ t('workspace.toggleSessions') }}
      </Tooltip>
      <div class="brand">
        <span class="i-lucide-sparkles" />
        <span>{{ t('workspace.title') }}</span>
      </div>
      <span v-if="!connection.connected" class="offline">{{ t('layout.reconnecting') }}</span>
      <div class="ws-actions">
        <Tooltip>
          <template #trigger>
            <Button size="small" quaternary circle icon="i-lucide-columns-2" :aria-label="t('workspace.toggleSplit')" :pressed="layout.split" @click="toggleSplit" />
          </template>
          {{ layout.split ? t('workspace.closeSplit') : t('workspace.toggleSplit') }}
        </Tooltip>
        <Tooltip>
          <template #trigger>
            <span class="dot-host">
              <Button size="small" quaternary circle :icon="layout.rightOpen ? 'i-lucide-panel-right-close' : 'i-lucide-panel-right-open'" :aria-label="t('workspace.togglePanel')" :pressed="layout.rightOpen" @click="layout.rightOpen = !layout.rightOpen" />
              <span v-if="unseen" class="new-dot" />
            </span>
          </template>
          {{ unseen ? t('workspace.panelNew') : t('workspace.togglePanel') }}
        </Tooltip>
        <Button type="primary" secondary icon="i-lucide-layout-dashboard" :title="t('workspace.dashboardHint')" @click="router.push(workspace.returnTo)">{{ t('workspace.dashboard') }}</Button>
      </div>
    </header>

    <div class="ws-body">
      <aside v-if="layout.leftOpen" class="ws-left" :style="{ width: `${sides.left}px` }">
        <WorkspaceSidebar @dragging="(id) => (draggingSession = id)" />
      </aside>
      <div
        class="resizer"
        :class="{ active: dragging === 'left', edge: !layout.leftOpen }"
        role="separator"
        aria-orientation="vertical"
        tabindex="0"
        :aria-label="t('workspace.resize')"
        :title="t('workspace.resizeHint')"
        @pointerdown="resizeSide($event, 'left')"
        @dblclick="resetSide('left')"
        @keydown="nudge($event, 'left')"
      />

      <main
        ref="panes"
        class="ws-center"
        @dragover="draggingSession && ($event.preventDefault(), (overDrop = true))"
        @dragleave="overDrop = false"
        @drop="onDrop"
      >
        <FairyPane pane="main" :style="layout.split ? { flex: `${layout.splitRatio} 1 0` } : { flex: '1 1 0' }" />
        <template v-if="layout.split">
          <div
            class="resizer split"
            :class="{ active: dragging === 'split' }"
            role="separator"
            aria-orientation="vertical"
            :aria-label="t('workspace.resize')"
            :title="t('workspace.resize')"
            @pointerdown="resizeSplit"
            @dblclick="layout.splitRatio = 0.5"
          />
          <FairyPane pane="split" closable :style="{ flex: `${1 - layout.splitRatio} 1 0` }" @close="closeSplit" />
        </template>
        <div v-if="draggingSession" class="drop-zone" :class="{ over: overDrop }">
          <span class="i-lucide-columns-2" />
          <span>{{ t('workspace.dropToSplit') }}</span>
        </div>
      </main>

      <div
        class="resizer"
        :class="{ active: dragging === 'right', edge: !layout.rightOpen }"
        role="separator"
        aria-orientation="vertical"
        tabindex="0"
        :aria-label="t('workspace.resize')"
        :title="t('workspace.resizeHint')"
        @pointerdown="resizeSide($event, 'right')"
        @dblclick="resetSide('right')"
        @keydown="nudge($event, 'right')"
      />
      <aside v-if="layout.rightOpen" class="ws-right" :style="{ width: `${sides.right}px` }">
        <WorkspacePanel @close="layout.rightOpen = false" />
      </aside>
    </div>
    <!-- While dragging, a sheet keeps the pointer out of the panel's frames. -->
    <div v-if="dragging" class="drag-sheet" />
  </div>
</template>

<style scoped>
.ws {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--fg);
}

.ws.dragging {
  user-select: none;
  cursor: col-resize;
}

.ws-top {
  flex: none;
  height: 56px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px 0 12px;
  border-bottom: 1px solid var(--line);
  background: var(--s1);
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.brand > span:first-child {
  color: var(--primary);
}

.offline {
  color: var(--warn);
  font-size: 12px;
}

.ws-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}

.dot-host {
  position: relative;
  display: inline-flex;
}

.new-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 0 2px var(--s1);
  pointer-events: none;
}

.ws-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.ws-left,
.ws-right {
  flex: none;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}

.ws-center {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
}

.ws-center > :deep(.pane) {
  min-width: 0;
}

.resizer {
  flex: none;
  width: 5px;
  margin: 0 -2px;
  position: relative;
  z-index: 2;
  cursor: col-resize;
  background: linear-gradient(to right, transparent 2px, var(--line) 2px, var(--line) 3px, transparent 3px);
}

.resizer.edge {
  margin: 0;
  background: none;
}

.resizer:hover,
.resizer.active,
.resizer:focus-visible {
  background: linear-gradient(to right, transparent 1px, var(--primary) 1px, var(--primary) 4px, transparent 4px);
  outline: none;
}

.drop-zone {
  position: absolute;
  top: 12px;
  right: 12px;
  bottom: 12px;
  width: calc(50% - 18px);
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 2px dashed var(--primary);
  border-radius: var(--radius);
  background: var(--primary-soft);
  color: var(--primary);
  font-weight: 600;
  pointer-events: none;
  opacity: 0.7;
}

.drop-zone.over {
  opacity: 1;
  background: var(--primary-soft-hover);
}

.drop-zone > span:first-child {
  font-size: 28px;
}

.drag-sheet {
  position: fixed;
  inset: 0;
  z-index: 50;
  cursor: col-resize;
}
</style>
