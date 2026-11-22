<script setup lang="ts">
import { Button, Dropdown, type DropdownOption, Input, Spin, Tooltip, useToast } from '@mushinjs/ui'
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call } from '../../api'
import { useFairyPane, useFairyStore } from '../../stores/fairy'
import { workspace } from '../../stores/workspace'
import type { FairyGroup, FairySessionSummary } from '../../types'

/**
 * The sessions column: a new conversation, links to the dashboard and Fairy's settings, and the conversations
 * by group. Fairy files a conversation under the group of what it works on; drag one onto a group to move it,
 * or onto the middle to open it beside the other.
 */
const emit = defineEmits<{ dragging: [session: string | undefined] }>()

const { t, locale } = useI18n()
const router = useRouter()
const toast = useToast()
const fairy = useFairyStore()

const query = ref('')

const matches = (session: FairySessionSummary) => !query.value.trim() || (session.title || t('fairy.untitled')).toLowerCase().includes(query.value.trim().toLowerCase())

function groupName(group: FairyGroup) {
  const lang = locale.value
  return group.labels?.[lang] ?? group.labels?.[lang.split('-')[0]!] ?? group.name
}

interface Section {
  key: string
  name: string
  icon: string
  group?: FairyGroup
  sessions: FairySessionSummary[]
  /** Newest activity in it, to order the groups. */
  latest: number
}

const sections = computed<Section[]>(() => {
  const open = fairy.sessions.filter((session) => !session.done && matches(session))
  const byGroup = new Map<string, FairySessionSummary[]>()
  for (const session of open) {
    const key = session.group && fairy.groups.some((group) => group.id === session.group) ? session.group : ''
    byGroup.set(key, [...byGroup.get(key) ?? [], session])
  }
  const groups: Section[] = fairy.groups
    .map((group) => {
      const sessions = byGroup.get(group.id) ?? []
      return { key: group.id, name: groupName(group), icon: groupIcon(group), group, sessions, latest: Math.max(group.createdAt, ...sessions.map((session) => session.updatedAt)) }
    })
    // A search hides the groups it finds nothing in.
    .filter((section) => !query.value.trim() || section.sessions.length)
    .sort((a, b) => b.latest - a.latest)
  const loose = byGroup.get('') ?? []
  const done = fairy.sessions.filter((session) => session.done && matches(session))
  return [
    ...groups,
    { key: 'chats', name: t('workspace.chats'), icon: 'i-lucide-messages-square', sessions: loose, latest: 0 },
    ...(done.length ? [{ key: 'done', name: t('workspace.done'), icon: 'i-lucide-archive', sessions: done, latest: 0 }] : []),
  ]
})

function groupIcon(group: FairyGroup) {
  const kind = group.resource?.split(':')[0]
  return { plugin: 'i-lucide-puzzle', bot: 'i-lucide-bot', flow: 'i-lucide-network', provider: 'i-lucide-key-round', kb: 'i-lucide-library', persona: 'i-lucide-circle-user' }[kind ?? ''] ?? 'i-lucide-folder'
}

/** The conversation open in a pane, to mark it in the list. */
const openIn = (id: string) => [useFairyStore().current === id ? 'main' : '', workspace.layout.split && useFairyPane('split').current === id ? 'split' : ''].filter(Boolean)

function target() {
  return workspace.layout.split ? useFairyPane(workspace.focused) : useFairyStore()
}

function openSession(id: string, pane?: 'main' | 'split') {
  if (pane === 'split') workspace.layout.split = true
  const conversation = pane ? useFairyPane(pane) : target()
  if (pane) workspace.focused = pane
  conversation.load(id).catch((error: Error) => toast.error(error.message))
}

function newChat() {
  target().newChat()
}

// ---- menus ----

const renaming = ref<{ kind: 'session' | 'group'; id: string; text: string }>()
const renameInput = ref<InstanceType<typeof Input>[]>()

function startRename(kind: 'session' | 'group', id: string, text: string) {
  renaming.value = { kind, id, text }
  nextTick(() => (renameInput.value?.[0] as any)?.focus?.())
}

async function saveRename() {
  const draft = renaming.value
  renaming.value = undefined
  if (!draft?.text.trim()) return
  try {
    if (draft.kind === 'session') await fairy.updateSession(draft.id, { title: draft.text.trim() })
    else {
      await call('fairy.groups.update', { id: draft.id, name: draft.text.trim() })
      await fairy.refreshSessions()
    }
  } catch (error) {
    toast.error((error as Error).message)
  }
}

function sessionMenu(session: FairySessionSummary): DropdownOption[] {
  const groups = fairy.groups.filter((group) => group.id !== session.group)
  return [
    { key: 'open', label: t('workspace.open'), icon: 'i-lucide-message-square' },
    { key: 'split', label: t('workspace.openSplit'), icon: 'i-lucide-columns-2' },
    { key: 'rename', label: t('workspace.rename'), icon: 'i-lucide-pencil' },
    { key: session.done ? 'undone' : 'done', label: session.done ? t('workspace.markOpen') : t('workspace.markDone'), icon: session.done ? 'i-lucide-archive-restore' : 'i-lucide-archive' },
    ...(groups.length || session.group
      ? [{
          type: 'group' as const,
          label: t('workspace.moveTo'),
          children: [
            ...groups.map((group) => ({ key: `group:${group.id}`, label: groupName(group), icon: groupIcon(group) })),
            ...(session.group ? [{ key: 'ungroup', label: t('workspace.chats'), icon: 'i-lucide-messages-square' }] : []),
          ],
        }]
      : []),
    { key: 'newGroup', label: t('workspace.moveToNew'), icon: 'i-lucide-folder-plus' },
    { type: 'divider' },
    { key: 'delete', label: t('workspace.delete'), icon: 'i-lucide-trash-2', danger: true },
  ]
}

async function onSessionMenu(session: FairySessionSummary, key: string) {
  try {
    if (key === 'open') openSession(session.id)
    else if (key === 'split') openSession(session.id, 'split')
    else if (key === 'rename') startRename('session', session.id, session.title)
    else if (key === 'done' || key === 'undone') await fairy.updateSession(session.id, { done: key === 'done' })
    else if (key === 'ungroup') await fairy.updateSession(session.id, { group: null })
    else if (key.startsWith('group:')) await fairy.updateSession(session.id, { group: key.slice(6) })
    else if (key === 'newGroup') {
      const group = await call<FairyGroup>('fairy.groups.create', { name: t('workspace.newGroupName') })
      await fairy.updateSession(session.id, { group: group.id })
      startRename('group', group.id, group.name)
    } else if (key === 'delete') {
      await useFairyStore().remove(session.id)
      if (useFairyPane('split').current === session.id) useFairyPane('split').newChat()
    }
  } catch (error) {
    toast.error((error as Error).message)
  }
}

const groupMenu: DropdownOption[] = [
  { key: 'rename', label: t('workspace.renameGroup'), icon: 'i-lucide-pencil' },
  { key: 'delete', label: t('workspace.deleteGroup'), icon: 'i-lucide-trash-2', danger: true, description: t('workspace.deleteGroupHint') },
]

async function onGroupMenu(group: FairyGroup, key: string) {
  try {
    if (key === 'rename') startRename('group', group.id, groupName(group))
    else if (key === 'delete') {
      await call('fairy.groups.delete', { id: group.id })
      await fairy.refreshSessions()
    }
  } catch (error) {
    toast.error((error as Error).message)
  }
}

async function addGroup() {
  try {
    const group = await call<FairyGroup>('fairy.groups.create', { name: t('workspace.newGroupName') })
    await fairy.refreshSessions()
    startRename('group', group.id, group.name)
  } catch (error) {
    toast.error((error as Error).message)
  }
}

// ---- drag and drop ----

const MIME = 'application/x-fairy-session'
const dropOn = ref<string>()

function onDragStart(event: DragEvent, session: FairySessionSummary) {
  event.dataTransfer?.setData(MIME, session.id)
  event.dataTransfer?.setData('text/plain', session.title)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  emit('dragging', session.id)
}

function onDragEnd() {
  dropOn.value = undefined
  emit('dragging', undefined)
}

function onDragOver(event: DragEvent, section: Section) {
  if (!event.dataTransfer?.types.includes(MIME)) return
  event.preventDefault()
  dropOn.value = section.key
}

async function onDrop(event: DragEvent, section: Section) {
  const id = event.dataTransfer?.getData(MIME)
  dropOn.value = undefined
  emit('dragging', undefined)
  if (!id) return
  event.preventDefault()
  const session = fairy.sessions.find((item) => item.id === id)
  if (!session) return
  try {
    if (section.key === 'done') await fairy.updateSession(id, { done: true })
    else if (section.key === 'chats') await fairy.updateSession(id, { group: null, ...(session.done ? { done: false } : {}) })
    else await fairy.updateSession(id, { group: section.key, ...(session.done ? { done: false } : {}) })
  } catch (error) {
    toast.error((error as Error).message)
  }
}

const relative = (ts: number) => {
  const minutes = Math.round((Date.now() - ts) / 60_000)
  if (minutes < 1) return t('workspace.justNow')
  if (minutes < 60) return t('workspace.minutesAgo', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('workspace.hoursAgo', { n: hours })
  return t('workspace.daysAgo', { n: Math.round(hours / 24) })
}
</script>

<template>
  <div class="side">
    <nav class="side-nav">
      <button type="button" class="nav-item" @click="newChat">
        <span class="i-lucide-square-pen" />{{ t('workspace.newChat') }}
      </button>
      <button type="button" class="nav-item" @click="router.push('/overview')">
        <span class="i-lucide-layout-grid" />{{ t('workspace.dashboard') }}
      </button>
      <button type="button" class="nav-item" @click="workspace.openView({ kind: 'page', path: '/settings/fairy/skills' })">
        <span class="i-lucide-puzzle" />{{ t('workspace.skills') }}
      </button>
      <button type="button" class="nav-item" @click="workspace.openView({ kind: 'page', path: '/settings/fairy' })">
        <span class="i-lucide-settings" />{{ t('workspace.settings') }}
      </button>
    </nav>

    <div class="side-head">
      <span>{{ t('workspace.sessions') }}</span>
      <Tooltip>
        <template #trigger><Button size="tiny" quaternary circle icon="i-lucide-folder-plus" :aria-label="t('workspace.newGroup')" @click="addGroup" /></template>
        {{ t('workspace.newGroup') }}
      </Tooltip>
    </div>
    <div class="side-search">
      <Input v-model:value="query" size="small" clearable :placeholder="t('workspace.search')" />
    </div>

    <div class="side-list">
      <section
        v-for="section in sections"
        :key="section.key"
        class="group"
        :class="{ drop: dropOn === section.key }"
        @dragover="onDragOver($event, section)"
        @dragleave="dropOn === section.key && (dropOn = undefined)"
        @drop="onDrop($event, section)"
      >
        <div class="group-head">
          <button type="button" class="group-toggle" :aria-expanded="!workspace.layout.folded.includes(section.key)" @click="workspace.toggleFold(section.key)">
            <span class="i-lucide-chevron-right chevron" :class="{ open: !workspace.layout.folded.includes(section.key) || !!query.trim() }" />
            <span :class="section.icon" class="group-icon" />
            <Input
              v-if="section.group && renaming?.kind === 'group' && renaming.id === section.key"
              ref="renameInput"
              v-model:value="renaming.text"
              size="tiny"
              @click.stop
              @keydown.enter.prevent="saveRename"
              @keydown.esc="renaming = undefined"
              @blur="saveRename"
            />
            <span v-else class="group-name" :title="section.group?.resource">{{ section.name }}</span>
            <span class="count">{{ section.sessions.length }}</span>
          </button>
          <Dropdown v-if="section.group" :options="groupMenu" placement="bottom" align="end" @select="(key: string) => onGroupMenu(section.group!, key)">
            <Button size="tiny" quaternary circle icon="i-lucide-ellipsis" :aria-label="t('workspace.groupMenu')" class="row-menu" />
          </Dropdown>
        </div>
        <template v-if="!workspace.layout.folded.includes(section.key) || query.trim()">
          <p v-if="!section.sessions.length" class="empty">{{ section.key === 'chats' ? t('workspace.noChats') : t('workspace.emptyGroup') }}</p>
          <div
            v-for="session in section.sessions"
            :key="session.id"
            class="row"
            :class="{ active: openIn(session.id).length }"
            draggable="true"
            @dragstart="onDragStart($event, session)"
            @dragend="onDragEnd"
          >
            <Input
              v-if="renaming?.kind === 'session' && renaming.id === session.id"
              ref="renameInput"
              v-model:value="renaming.text"
              size="tiny"
              @keydown.enter.prevent="saveRename"
              @keydown.esc="renaming = undefined"
              @blur="saveRename"
            />
            <button v-else type="button" class="row-main" :title="session.title" @click="openSession(session.id)" @dblclick="startRename('session', session.id, session.title)">
              <Spin v-if="session.running" :size="10" class="row-dot" />
              <span v-else class="row-dot dot" :class="{ on: openIn(session.id).length }" />
              <span class="row-title">{{ session.title || t('fairy.untitled') }}</span>
              <span v-if="openIn(session.id).includes('split')" class="i-lucide-columns-2 row-split" :title="t('workspace.inSplit')" />
              <span class="row-time">{{ relative(session.updatedAt) }}</span>
            </button>
            <Dropdown :options="sessionMenu(session)" placement="bottom" align="end" @select="(key: string) => onSessionMenu(session, key)">
              <Button size="tiny" quaternary circle icon="i-lucide-ellipsis" :aria-label="t('workspace.sessionMenu')" class="row-menu" />
            </Dropdown>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.side {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--s1);
  font-size: 13px;
}

.side-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px 6px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.nav-item:hover {
  background: var(--s2);
}

.nav-item > span {
  font-size: 16px;
  color: var(--fg2);
}

.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px 4px 18px;
  color: var(--fg3);
  font-size: 12px;
  font-weight: 600;
}

.side-search {
  padding: 0 10px 6px;
}

.side-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 6px 12px;
}

.group {
  border-radius: 8px;
  padding: 2px 0;
}

.group.drop {
  background: var(--primary-soft);
  outline: 1px dashed var(--primary);
}

.group-head {
  display: flex;
  align-items: center;
}

.group-toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 6px;
  border: none;
  background: transparent;
  color: var(--fg2);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}

.chevron {
  flex: none;
  font-size: 12px;
  transition: transform 0.15s;
}

.chevron.open {
  transform: rotate(90deg);
}

.group-icon {
  flex: none;
  font-size: 14px;
}

.group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.count {
  color: var(--fg3);
  font-weight: 400;
  font-size: 12px;
}

.empty {
  margin: 2px 0 6px 30px;
  color: var(--fg3);
  font-size: 12px;
}

.row {
  display: flex;
  align-items: center;
  border-radius: 8px;
  padding-right: 2px;
}

.row:hover {
  background: var(--s2);
}

.row.active {
  background: var(--primary-soft);
}

.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px 6px 12px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.row-dot {
  flex: none;
}

.dot {
  width: 6px;
  height: 6px;
  margin: 0 2px;
  border-radius: 50%;
  background: var(--line-strong);
}

.dot.on {
  background: var(--primary);
}

.row-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.row-split {
  flex: none;
  color: var(--fg3);
}

.row-time {
  flex: none;
  color: var(--fg3);
  font-size: 11px;
}

.row-menu {
  opacity: 0;
}

.row:hover .row-menu,
.group-head:hover .row-menu,
.row-menu[aria-expanded='true'] {
  opacity: 1;
}
</style>
