<script setup lang="ts">
import { Button, Dropdown, type DropdownOption, Input, Popover, Spin, Tag, Tooltip, useConfirm, useToast } from '@mushinjs/ui'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { type ChatItem, DELEGATE, useConversation } from '../stores/fairy'
import { type Recommendation, useFairySceneStore } from '../stores/fairyScene'
import { useDataStore } from '../stores/data'
import type { FairySkill } from '../types'
import FairyMessage from './fairy/FairyMessage.vue'
import FairyToolCall from './fairy/FairyToolCall.vue'
import AskCard from './fairy/AskCard.vue'
import { actionLabel } from './fairy/records'
import CommandPalette, { type PaletteItem } from './fairy/CommandPalette.vue'
import HistoryDrawer from './fairy/HistoryDrawer.vue'
import PanelIcon from './flow/editor/PanelIcon.vue'
import EffortPicker from './fairy/EffortPicker.vue'
import ModelPicker from './fairy/ModelPicker.vue'

/**
 * `mode` is set where Fairy can float or dock; the button switches between the two. In the workspace
 * (`variant: 'workspace'`) the sessions column has new, history and delete, so the header only names the
 * conversation.
 */
defineProps<{ closable?: boolean; mode?: 'docked' | 'floating'; variant?: 'dock' | 'workspace' }>()
const emit = defineEmits<{ close: []; toggleMode: [] }>()

const { t, te } = useI18n()
const router = useRouter()
const fairy = useConversation()
const scenes = useFairySceneStore()
const data = useDataStore()

const input = ref('')
const list = ref<HTMLElement>()
const expanded = ref(new Set<string>())
const picked = ref<FairySkill[]>([])
/** The bot of a bot command picked with `/`, told to Fairy with the next message. */
const commandBot = ref<{ name: string; bot: string }>()
const palette = ref<InstanceType<typeof CommandPalette>>()
const paletteClosed = ref(false)
const showHistory = ref(false)
const toast = useToast()
const dialog = useConfirm()
const field = ref<InstanceType<typeof Input>>()

/** The conversation's title for the workspace header; a new one has none yet. */
const title = computed(() => (fairy.current ? fairy.sessions.find((session) => session.id === fairy.current)?.title || t('fairy.untitled') : t('fairy.newChat')))

const moreOptions = computed<DropdownOption[]>(() => [
  { key: 'delete', label: t('fairy.deleteChat'), icon: 'i-lucide-trash-2', danger: true },
])

function onMore(key: string) {
  const id = fairy.current
  if (key !== 'delete' || !id) return
  dialog.warning({
    title: t('fairy.deleteConfirm'),
    content: t('fairy.deleteConfirmText', { title: title.value }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => fairy.remove(id),
  })
}

/** Puts the cursor at the end of the input. */
async function focusInput() {
  await nextTick()
  field.value?.focus()
  const el = field.value?.el
  if (el) el.setSelectionRange(el.value.length, el.value.length)
}

/** A click on the box around the input, outside its buttons, goes to the input. */
function onComposerClick(event: MouseEvent) {
  if (!(event.target as HTMLElement).closest('button, a, input, textarea, [role="button"]')) field.value?.focus()
}

// ---- copy and edit ----

/** The user message being edited: its place among the user messages, and the draft. */
const editing = ref<{ ordinal: number; text: string }>()

/** Each user item's place among the user messages, which the server counts the same way. */
const ordinals = computed(() => {
  const map = new Map<ChatItem, number>()
  let n = 0
  for (const item of fairy.items) if (item.kind === 'user') map.set(item, n++)
  return map
})

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('fairy.copied'))
  } catch {
    toast.error(t('fairy.copyFailed'))
  }
}

function startEdit(item: ChatItem) {
  if (item.kind !== 'user' || fairy.running) return
  editing.value = { ordinal: ordinals.value.get(item) ?? 0, text: item.text }
}

async function saveEdit() {
  const draft = editing.value
  if (!draft?.text.trim()) return
  editing.value = undefined
  await fairy.edit(draft.ordinal, draft.text.trim(), { scene: { ...scenes.scene } })
}

// ---- model and effort for the next messages ----

const modelPicker = ref<InstanceType<typeof ModelPicker>>()

/** "Try another model" and /model open the model list above the input. */
function changeModel() {
  modelPicker.value?.open()
}

/** `/` at the start of the input lists commands; `$` after a space lists skills. */
const trigger = computed(() => {
  if (paletteClosed.value) return
  const slash = /^\/([^\s/]*)$/.exec(input.value)
  if (slash) return { mode: '/' as const, query: slash[1], from: 0 }
  const dollar = /(^|\s)\$([^\s$]*)$/.exec(input.value)
  if (dollar) return { mode: '$' as const, query: dollar[2], from: dollar.index + dollar[1].length }
  return undefined
})

watch(input, () => (paletteClosed.value = false))

/** Sends a message; while Fairy works, it joins the turn and Fairy reads it before its next step. */
async function send(text = input.value) {
  if (!text.trim() && !picked.value.length && !fairy.quote) return
  // A new conversation gets its id when its turn starts; until then there is nothing to add to.
  if (fairy.running && !fairy.current) return
  const skills = picked.value
  const scene = { ...scenes.scene }
  const bot = commandBot.value
  if (bot && text.trim().startsWith(`/${bot.name}`)) scene.state = { ...scene.state, commandBot: bot.bot }
  input.value = ''
  picked.value = []
  commandBot.value = undefined
  scrollToEnd(true)
  await fairy.send(text.trim(), { skills, scene })
}

/** A recommendation goes into the input, with its skill, to be edited and sent from there. */
function useRecommendation(item: Recommendation) {
  const skill = item.skill ? fairy.skills.find((entry) => entry.id === item.skill && entry.enabled) : undefined
  scenes.dismiss(item.id)
  input.value = item.prompt
  if (skill && !picked.value.some((entry) => entry.id === skill.id)) picked.value = [...picked.value, skill]
  focusInput()
}

function onPick(item: PaletteItem) {
  const at = trigger.value
  if (item.kind === 'skill') {
    if (!picked.value.some((skill) => skill.id === item.skill.id)) picked.value = [...picked.value, item.skill]
    input.value = at ? input.value.slice(0, at.from).trimEnd() : input.value
    if (input.value) input.value += ' '
  } else if (item.kind === 'bot') {
    input.value = `/${item.name} `
    commandBot.value = { name: item.name, bot: item.command.bot }
  } else {
    input.value = ''
    runBuiltin(item.name)
  }
  paletteClosed.value = item.kind !== 'bot'
}

function runBuiltin(name: string) {
  switch (name) {
    case 'new':
      fairy.newChat()
      picked.value = []
      break
    case 'history':
      showHistory.value = true
      break
    case 'model':
      changeModel()
      break
    case 'status': {
      const chars = fairy.items.reduce((sum, item) => sum + ('text' in item ? item.text.length : item.kind === 'tool' ? JSON.stringify(item.input ?? '').length + JSON.stringify(item.result ?? '').length : 0), 0)
      fairy.note(t('fairyPalette.statusText', {
        messages: fairy.items.filter((item) => item.kind === 'user' || item.kind === 'assistant').length,
        chars,
        input: fairy.usage?.inputTokens ?? '—',
        output: fairy.usage?.outputTokens ?? '—',
        scene: scenes.scene.label,
      }))
      break
    }
    case 'help':
      fairy.note(t('fairyPalette.helpText', {
        commands: fairy.commands.builtin.map((command) => `/${command.name}`).join(' '),
        bots: fairy.commands.bots.length,
        skills: fairy.skills.filter((skill) => skill.enabled).length,
      }))
      break
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (trigger.value && palette.value?.count()) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      palette.value.move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      palette.value.choose()
      return
    }
  }
  if (event.key === 'Escape' && trigger.value) {
    paletteClosed.value = true
    return
  }
  if (event.key === 'Backspace' && !input.value && picked.value.length) {
    picked.value = picked.value.slice(0, -1)
    return
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    send()
  }
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type Row =
  | { kind: 'item'; item: ChatItem }
  | { kind: 'group'; key: string; action: string; items: ToolItem[]; failed: number; running: boolean; reason: string }

/** Runs of this many calls of one tool in a row fold into one line, so retries do not flood the chat. */
const GROUP_FROM = 3

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const items = fairy.items
  for (let index = 0; index < items.length;) {
    const item = items[index]
    let end = index + 1
    if (item.kind === 'tool') {
      while (end < items.length && items[end].kind === 'tool' && (items[end] as ToolItem).action === item.action) end++
    }
    const run = items.slice(index, end) as ToolItem[]
    if (run.length >= GROUP_FROM && !run.some((call) => call.state === 'confirm' || call.action === DELEGATE || call.action.startsWith('ui.'))) {
      const failures = run.filter((call) => call.state === 'error' || call.state === 'declined')
      const reason = failures.at(-1)?.error?.replace(/^Error:\s*/, '').split('\n')[0] ?? ''
      out.push({ kind: 'group', key: `group:${item.kind === 'tool' ? item.id : index}`, action: item.kind === 'tool' ? item.action : '', items: run, failed: failures.length, running: run.some((call) => call.state === 'running'), reason })
    } else {
      for (const single of items.slice(index, end)) out.push({ kind: 'item', item: single })
    }
    index = end
  }
  return out
})

/**
 * Each question of the open conversation shows on the ui.ask call that asked it; the rest (a helper's
 * questions) wait below the chat.
 */
const inlineAsks = computed(() => {
  const map = new Map<string, ReturnType<typeof fairy.visibleAsks>[number]>()
  const open = fairy.visibleAsks().filter((ask) => !ask.session || ask.session === fairy.current)
  for (const item of fairy.items) {
    if (item.kind !== 'tool' || item.action !== 'ui.ask' || item.state !== 'running') continue
    const question = (item.input as { question?: unknown } | undefined)?.question
    const ask = open.find((entry) => entry.question === question && ![...map.values()].includes(entry))
    if (ask) map.set(item.id, ask)
  }
  return map
})
const otherAsks = computed(() => {
  const shown = new Set(inlineAsks.value.values())
  return fairy.visibleAsks().filter((ask) => !shown.has(ask))
})

function groupSummary(row: Extract<Row, { kind: 'group' }>) {
  const ok = row.items.filter((call) => call.state === 'ok').length
  return [
    ok ? t('fairy.groupOk', { n: ok }) : '',
    row.failed ? t('fairy.groupFailed', { n: row.failed }) : '',
    row.running ? t('fairy.state.running') : '',
  ].filter(Boolean).join(' · ')
}

function toggle(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/**
 * The chat follows new content only while you are at its end (within a few lines); scrolled up to read, it
 * stays put and a button says there is more below.
 */
const pinned = ref(true)
const unread = ref(false)

function onListScroll() {
  const el = list.value
  if (!el) return
  pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  if (pinned.value) unread.value = false
}

async function scrollToEnd(force = false) {
  await nextTick()
  const el = list.value
  if (!el) return
  if (!force && !pinned.value) {
    unread.value = el.scrollHeight - el.scrollTop - el.clientHeight >= 48
    return
  }
  el.scrollTo({ top: el.scrollHeight, behavior: force && unread.value ? 'smooth' : 'auto' })
  pinned.value = true
  unread.value = false
}

watch(() => [fairy.items.length, fairy.streaming, fairy.items.at(-1), fairy.visibleAsks().length, fairy.queued.length], () => scrollToEnd(), { deep: true })
// A conversation opens at its end.
watch(() => fairy.current, () => scrollToEnd(true))
onMounted(() => scrollToEnd(true))
</script>

<template>
  <div class="dock-inner">
    <header class="dock-head">
      <div class="dock-title">
        <template v-if="variant === 'workspace'">
          <span class="pane-title" :title="title">{{ title }}</span>
        </template>
        <template v-else>
          <span class="i-lucide-sparkles text-[18px]" />
          <span>{{ t('nav.fairy') }}</span>
        </template>
        <Popover placement="bottom" align="start" :style="{ maxWidth: '300px' }">
          <template #trigger>
            <button type="button" class="scene-tag" :title="t('fairyScene.whatHere')" data-fairy-target="fairy.scene">
              {{ scenes.scene.label }}
            </button>
          </template>
          <div class="scene-pop">
            <div class="scene-pop-title">{{ t('fairyScene.whatHere') }}</div>
            <p>{{ scenes.scene.hint }}</p>
          </div>
        </Popover>
      </div>
      <div class="dock-actions">
        <template v-if="variant !== 'workspace'">
          <Tooltip>
            <template #trigger>
              <Button size="small" quaternary circle :aria-label="t('fairy.history')" icon="i-lucide-history" @click="showHistory = true" />
            </template>
            {{ t('fairy.history') }}
          </Tooltip>
          <Tooltip>
            <template #trigger>
              <Button size="small" quaternary circle :aria-label="t('fairy.newChat')" icon="i-lucide-plus" @click="fairy.newChat()" />
            </template>
            {{ t('fairy.newChat') }}
          </Tooltip>
          <Dropdown v-if="fairy.current" :options="moreOptions" align="end" @select="onMore">
            <Button size="small" quaternary circle :aria-label="t('fairy.more')" icon="i-lucide-ellipsis" />
          </Dropdown>
        </template>
        <Tooltip v-if="mode">
          <template #trigger>
            <Button size="small" quaternary circle :aria-label="mode === 'docked' ? t('fairy.float') : t('fairy.dock')" data-fairy-target="fairy.mode" @click="emit('toggleMode')">
              <template #icon>
                <span v-if="mode === 'docked'" class="i-lucide-app-window" />
                <PanelIcon v-else side="right" :open="true" />
              </template>
            </Button>
          </template>
          {{ mode === 'docked' ? t('fairy.float') : t('fairy.dock') }}
        </Tooltip>
        <Button v-if="closable" size="small" quaternary circle :aria-label="t('fairy.close')" icon="i-lucide-x" @click="emit('close')" />
      </div>
    </header>

    <div ref="list" class="dock-list" @scroll.passive="onListScroll">
      <div class="dock-column">
        <div v-if="fairy.task" class="task-bar">
          <span class="i-lucide-scroll-text" />
          <span>{{ t('fairyTask.viewing', { role: te(`fairyTask.roles.${fairy.task.role}`) ? t(`fairyTask.roles.${fairy.task.role}`) : fairy.task.role }) }}</span>
          <Button size="tiny" secondary icon="i-lucide-arrow-left" @click="fairy.load(fairy.task.parent.session)">{{ t('fairyTask.back') }}</Button>
        </div>
        <div v-if="data.loadedProviders && !data.providers.length" class="dock-empty">
          <p>{{ t('fairy.needProvider') }}</p>
          <Button type="primary" @click="router.push('/setup')">{{ t('fairy.goSetup') }}</Button>
        </div>

        <div v-else-if="!fairy.items.length && !fairy.running" class="dock-empty">
          <p class="dock-hello">{{ scenes.welcome ?? t('fairy.hello') }}</p>
          <div v-if="scenes.recommendations.length" class="suggestions">
            <button v-for="item in scenes.recommendations" :key="item.id" class="suggestion" :class="{ urgent: item.urgent }" type="button" :title="t('fairy.useSuggestion')" @click="useRecommendation(item)">
              <span class="suggestion-text">{{ item.text }}</span>
              <Tag v-if="item.skill" size="tiny" class="suggestion-skill">
                <template #icon><span class="i-lucide-puzzle" /></template>
                {{ fairy.skills.find((skill) => skill.id === item.skill)?.name ?? item.skill }}
              </Tag>
            </button>
          </div>
          <p class="dock-tip">{{ t('fairyPalette.tip') }}</p>
        </div>

        <template v-for="(row, index) in rows" :key="index">
          <div v-if="row.kind === 'group'" class="tool-group" :class="{ open: expanded.has(row.key) }">
            <button class="group-row" type="button" @click="toggle(row.key)">
              <Spin v-if="row.running" :size="14" />
              <span v-else-if="!row.failed" class="i-lucide-circle-check" color="var(--ok)" />
              <span v-else-if="row.failed === row.items.length" class="i-lucide-circle-x" color="var(--bad)" />
              <span v-else class="i-lucide-circle-alert" color="var(--warn)" />
              <span class="group-name" :title="row.action">{{ actionLabel(row.action, t, te) }}</span>
              <span class="group-count">×{{ row.items.length }}</span>
              <span class="group-state">{{ groupSummary(row) }}</span>
              <span class="i-lucide-chevron-down group-chevron" />
            </button>
            <div v-if="row.failed && !expanded.has(row.key)" class="group-reason" :title="row.reason">{{ row.reason }}</div>
            <div v-if="expanded.has(row.key)" class="group-items">
              <FairyToolCall
                v-for="item in row.items"
                :key="item.id"
                :item="item"
                :expanded="expanded.has(item.id)"
                @toggle="toggle(item.id)"
                @confirm="(approved) => fairy.confirm(item.id, approved)"
                @confirm-task="(approved) => fairy.confirmTask(item.id, approved)"
                @open-task="(session) => fairy.load(session)"
              />
            </div>
          </div>
          <template v-else>
            <template v-for="item in [row.item]" :key="index">
              <div v-if="item.kind === 'user' && editing && editing.ordinal === ordinals.get(item)" class="msg-edit">
                <Input
                  v-model:value="editing.text"
                  type="textarea"
                  :autosize="{ minRows: 2, maxRows: 8 }"
                  @keydown.enter.exact.prevent="saveEdit()"
                  @keydown.esc="editing = undefined"
                />
                <div class="msg-edit-actions">
                  <Button size="small" secondary @click="editing = undefined">{{ t('common.cancel') }}</Button>
                  <Button size="small" type="primary" :disabled="!editing.text.trim()" @click="saveEdit()">{{ t('fairy.resend') }}</Button>
                </div>
              </div>
              <div v-else-if="item.kind === 'user'" class="msg-wrap user">
                <div class="msg user">
                  <div v-if="item.skills?.length" class="msg-skills">
                    <span v-for="name in item.skills" :key="name" class="msg-skill"><span class="i-lucide-puzzle" />{{ name }}</span>
                  </div>
                  <div v-if="item.quote" class="msg-quote"><span class="i-lucide-message-circle-more" />{{ item.quote }}</div>
                  {{ item.text }}
                </div>
                <div class="msg-actions">
                  <Tooltip><template #trigger><Button size="tiny" quaternary circle icon="i-lucide-copy" :aria-label="t('fairy.copy')" @click="copy(item.text)" /></template>{{ t('fairy.copy') }}</Tooltip>
                  <Tooltip v-if="!fairy.running && item.text"><template #trigger><Button size="tiny" quaternary circle icon="i-lucide-pencil" :aria-label="t('fairy.edit')" @click="startEdit(item)" /></template>{{ t('fairy.edit') }}</Tooltip>
                </div>
              </div>
              <div v-else-if="item.kind === 'assistant'" class="msg-wrap assistant">
                <div class="msg assistant"><FairyMessage :text="item.text" /></div>
                <div class="msg-actions">
                  <Tooltip><template #trigger><Button size="tiny" quaternary circle icon="i-lucide-copy" :aria-label="t('fairy.copy')" @click="copy(item.text)" /></template>{{ t('fairy.copy') }}</Tooltip>
                </div>
              </div>
              <div v-else-if="item.kind === 'note'" class="msg note">
                <span class="i-lucide-info" /><span>{{ item.text }}</span>
              </div>
              <div v-else-if="item.kind === 'error' && item.code === 'max_steps'" class="msg limit">
                <span class="i-lucide-info" />
                <span>{{ t('fairy.maxSteps') }}</span>
                <Button v-if="index === rows.length - 1 && !fairy.running" size="small" secondary @click="send(t('fairy.continuePrompt'))">{{ t('fairy.continue') }}</Button>
              </div>
              <div v-else-if="item.kind === 'notice'" class="msg note">
                <span class="i-lucide-info" /><span>{{ t(`fairyNotice.${item.code}`) }}</span>
              </div>
              <div v-else-if="item.kind === 'error'" class="msg error">
                <div class="error-text"><span class="i-lucide-circle-alert" /> {{ item.text }}</div>
                <div v-if="index === rows.length - 1 && !fairy.running" class="error-actions">
                  <Button size="tiny" secondary icon="i-lucide-rotate-ccw" @click="fairy.retry({ scene: { ...scenes.scene } })">{{ t('fairy.retry') }}</Button>
                  <Button size="tiny" secondary icon="i-lucide-replace" @click="changeModel">{{ t('fairy.changeModel') }}</Button>
                </div>
              </div>
              <FairyToolCall
                v-else
                :item="item"
                :expanded="expanded.has(item.id)"
                :ask="inlineAsks.get(item.id)"
                @toggle="toggle(item.id)"
                @answer="(result) => fairy.answer(inlineAsks.get(item.id)!.id, result)"
                @confirm="(approved) => fairy.confirm(item.id, approved)"
                @confirm-task="(approved) => fairy.confirmTask(item.id, approved)"
                @open-task="(session) => fairy.load(session)"
              />
            </template>
          </template>
        </template>

        <AskCard v-for="ask in otherAsks" :key="ask.id" :ask="ask" @answer="(result) => fairy.answer(ask.id, result)" />

        <div v-if="fairy.streaming" class="msg assistant streaming"><FairyMessage :text="fairy.streaming" streaming /></div>
        <div v-else-if="fairy.running" class="thinking"><Spin :size="14" /> {{ t('fairy.thinking') }}</div>

        <!-- Written while Fairy works: below the work until it reads them before its next step. -->
        <div v-for="(item, index) in fairy.queued" :key="`${item.id}-${index}`" class="msg-wrap user queued">
          <div class="msg user">
            <div v-if="item.skills?.length" class="msg-skills">
              <span v-for="name in item.skills" :key="name" class="msg-skill"><span class="i-lucide-puzzle" />{{ name }}</span>
            </div>
            <div v-if="item.quote" class="msg-quote"><span class="i-lucide-message-circle-more" />{{ item.quote }}</div>
            {{ item.text }}
          </div>
          <div class="queued-note"><span class="i-lucide-clock-3" />{{ t('fairy.queuedNote') }}</div>
        </div>
      </div>
    </div>

    <div v-if="fairy.toolsStale && fairy.items.length" class="stale">
      <span class="i-lucide-info" />
      <span>{{ t('fairyMessage.toolsStale') }}</span>
      <button type="button" class="text-link" @click="fairy.newChat()">{{ t('fairy.newChat') }}</button>
    </div>

    <div v-if="fairy.items.length && scenes.banner && !fairy.running" class="banner">
      <span class="i-lucide-info" color="var(--warn)" />
      <button type="button" class="banner-text" :title="t('fairy.useSuggestion')" @click="useRecommendation(scenes.banner!)">{{ scenes.banner.text }}</button>
      <Button size="tiny" quaternary circle :aria-label="t('fairy.close')" icon="i-lucide-x" @click="scenes.dismiss(scenes.banner!.id)" />
    </div>

    <footer class="dock-input" data-fairy-target="fairy.input">
      <div class="composer-wrap">
        <button v-if="unread && !trigger" type="button" class="unread" @click="scrollToEnd(true)">
          <span class="i-lucide-arrow-down" />{{ t('fairy.newBelow') }}
        </button>
        <CommandPalette
          v-if="trigger"
          ref="palette"
          class="dock-palette"
          :mode="trigger.mode"
          :query="trigger.query"
          :scene="scenes.key"
          @pick="onPick"
        />
        <div class="composer" :class="{ disabled: !data.providers.length }" @click="onComposerClick">
          <div v-if="picked.length || fairy.quote" class="chips">
            <Tag v-if="fairy.quote" size="small" type="info" closable class="quote-chip" :title="fairy.quote.label" @close="fairy.quote = undefined">
              <template #icon><span class="i-lucide-message-circle-more" /></template>
              {{ t('fairy.quoted', { label: fairy.quote.label }) }}
            </Tag>
            <Tag v-for="skill in picked" :key="skill.id" size="small" type="success" closable @close="picked = picked.filter((item) => item.id !== skill.id)">
              <template #icon><span class="i-lucide-puzzle" /></template>
              {{ skill.name }}
            </Tag>
          </div>
          <Input
            ref="field"
            v-model:value="input"
            type="textarea"
            :bordered="false"
            :autosize="{ minRows: 1, maxRows: 8 }"
            :placeholder="fairy.running ? t('fairy.placeholderRunning') : t('fairy.placeholder')"
            :disabled="!data.providers.length"
            @keydown="onKeydown"
          />
          <div class="composer-bar">
            <div class="composer-pickers">
              <ModelPicker ref="modelPicker" />
              <EffortPicker />
            </div>
            <!-- While Fairy works: stop now, or send what you typed for it to read before its next step. -->
            <Button v-if="fairy.running" size="small" circle quaternary class="composer-stop" :aria-label="t('fairy.stop')" :title="t('fairy.stopHint')" icon="i-lucide-square" @click="fairy.cancel()" />
            <Button
              v-if="!fairy.running || input.trim() || picked.length || fairy.quote"
              size="small"
              circle
              type="primary"
              class="composer-send"
              :disabled="!input.trim() && !picked.length && !fairy.quote"
              :aria-label="fairy.running ? t('fairy.sendRunning') : t('fairy.send')"
              :title="fairy.running ? t('fairy.sendRunning') : t('fairy.send')"
              icon="i-lucide-arrow-up"
              @click="send()"
            />
          </div>
        </div>
      </div>
    </footer>

    <HistoryDrawer v-model:show="showHistory" />
  </div>
</template>

<style scoped>
.dock-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.dock-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid var(--line);
}

.dock-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-weight: 600;
}

.pane-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dock-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
}

.dock-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 16px;
  display: flex;
  flex-direction: column;
}

/* The conversation as one column; on a wide screen it stays readable instead of running edge to edge. */
.dock-column {
  flex: 1 0 auto;
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Tool calls in a row read as one list. */
.dock-column > .tool + .tool,
.dock-column > .tool + .tool-group,
.dock-column > .tool-group + .tool,
.dock-column > .tool-group + .tool-group {
  margin-top: -8px;
}

.dock-empty {
  margin: auto 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  text-align: center;
}

.task-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--s2);
  font-size: 13px;
}

.task-bar > span:nth-child(2) {
  flex: 1;
  min-width: 0;
}

.dock-hello {
  opacity: 0.75;
  line-height: 1.6;
  margin: 0 0 8px;
}

.suggestions {
  width: 100%;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.suggestion {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background-color 0.15s;
}

.suggestion:hover {
  border-color: var(--primary);
  background: var(--s2);
}

.suggestion.urgent {
  border-color: var(--warn);
}

.suggestion-text {
  min-width: 0;
}

.suggestion-skill {
  flex: none;
}

.dock-tip {
  font-size: 12px;
  opacity: 0.5;
  margin: 4px 0 0;
}

.scene-tag {
  font: inherit;
  font-size: 12px;
  font-weight: 400;
  padding: 1px 8px;
  border-radius: 10px;
  border: 1px solid var(--line-strong);
  background: transparent;
  color: inherit;
  opacity: 0.8;
  cursor: pointer;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scene-tag:hover {
  border-color: var(--primary);
  opacity: 1;
}

.scene-pop-title {
  font-weight: 600;
  margin-bottom: 4px;
}

.scene-pop p {
  margin: 0;
  line-height: 1.6;
  font-size: 13px;
}

.msg-skills {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
}

.msg-skill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.18);
}

.msg.note {
  align-self: stretch;
  max-width: none;
  font-size: 13px;
  background: var(--primary-soft);
  display: flex;
  gap: 6px;
  align-items: flex-start;
}

.msg.note > [class^="i-"] {
  margin-top: 4px;
  flex: none;
}

.stale {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 0 12px;
  font-size: 12px;
  color: var(--fg3);
}

.text-link {
  padding: 0;
  border: none;
  background: none;
  color: var(--primary);
  font: inherit;
  cursor: pointer;
}

.text-link:hover {
  text-decoration: underline;
}

.banner {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px;
  padding: 6px 8px 6px 10px;
  border-radius: 8px;
  background: var(--warn-soft);
  font-size: 13px;
}

.banner-text {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.banner-text:hover {
  text-decoration: underline;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.quote-chip {
  max-width: 100%;
  overflow: hidden;
}

.msg-quote {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  opacity: 0.75;
  padding-left: 6px;
  margin-bottom: 4px;
  border-left: 2px solid currentColor;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dock-palette {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 10;
}

.msg {
  max-width: 88%;
  padding: 8px 12px;
  border-radius: 12px;
  line-height: 1.6;
  font-size: 14px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* A message with its copy and edit buttons under it, shown on hover. */
.msg-wrap {
  display: flex;
  flex-direction: column;
  max-width: 88%;
}

.msg-wrap.user {
  align-self: flex-end;
  align-items: flex-end;
}

.msg-wrap.assistant {
  align-self: flex-start;
  align-items: flex-start;
}

.msg-wrap > .msg {
  max-width: 100%;
}

/* Written while Fairy works and not read yet: a lighter bubble with a note under it. */
.msg-wrap.queued > .msg.user {
  background: var(--primary-soft);
  color: var(--fg);
  border: 1px dashed var(--primary);
}

.queued-note {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--fg3);
}

.msg-actions {
  display: flex;
  gap: 2px;
  height: 24px;
  opacity: 0;
  transition: opacity 0.15s;
}

.msg-wrap:hover .msg-actions,
.msg-actions:focus-within {
  opacity: 1;
}

.msg-edit {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.msg-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.msg.user {
  background: var(--primary-soft);
  color: var(--fg);
  border: 1px dashed var(--primary);
}

.queued-note {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--fg3);
}

.msg-actions {
  display: flex;
  gap: 2px;
  height: 24px;
  opacity: 0;
  transition: opacity 0.15s;
}

.msg-wrap:hover .msg-actions,
.msg-actions:focus-within {
  opacity: 1;
}

.msg-edit {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.msg-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.msg.user {
  align-self: flex-end;
  background: var(--primary);
  color: var(--primary-fg);
  border-bottom-right-radius: 4px;
}

/* Fairy's replies sit in the column as text; only your own messages are bubbles. */
.msg.assistant {
  align-self: stretch;
  max-width: none;
  padding: 0;
  white-space: normal;
}

.msg-wrap.assistant {
  align-self: stretch;
  max-width: none;
}

.msg.streaming :deep(.fairy-md > :last-child)::after {
  content: '▍';
  opacity: 0.6;
  animation: blink 1s steps(2) infinite;
}

.msg.error {
  align-self: stretch;
  max-width: none;
  color: var(--bad);
  background: var(--bad-soft);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.error-text {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  word-break: break-word;
}

.error-text > span {
  flex: none;
  margin-top: 3px;
}

.error-actions {
  display: flex;
  gap: 6px;
}

@keyframes blink {
  50% { opacity: 0; }
}

.msg.limit {
  align-self: stretch;
  max-width: none;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--s2);
}

.msg.limit span {
  flex: 1;
}

.tool-group {
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 13px;
}

.group-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.group-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.group-count {
  flex: 1;
  opacity: 0.6;
  font-size: 12px;
}

.group-state {
  opacity: 0.6;
  font-size: 12px;
}

.group-chevron {
  opacity: 0.5;
  transition: transform 0.15s;
}

.tool-group.open .group-chevron {
  transform: rotate(180deg);
}

.group-reason {
  margin: -2px 10px 7px 32px;
  font-size: 12px;
  color: var(--bad);
  opacity: 0.85;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.group-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 8px 8px;
}

.thinking {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  opacity: 0.7;
}

.dock-input {
  padding: 4px 12px 12px;
}

.composer-wrap {
  position: relative;
  max-width: 760px;
  margin: 0 auto;
}

/* Shown while you read further up and more arrives below. */
.unread {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--s1);
  color: var(--fg2);
  font: inherit;
  font-size: 12px;
  box-shadow: var(--shadow-pop);
  cursor: pointer;
  animation: unread-in 0.15s ease-out;
}

.unread:hover {
  color: var(--fg);
  border-color: var(--line-strong);
}

@keyframes unread-in {
  from { opacity: 0; transform: translate(-50%, 4px); }
}

/* The input, its chips and its buttons in one box that grows with the text. */
.composer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 8px 6px 12px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--s2);
  cursor: text;
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s;
}

.composer:hover {
  border-color: var(--line-strong);
}

.composer:focus-within {
  border-color: var(--primary);
  background: var(--s1);
  box-shadow: 0 0 0 3px var(--focus);
}

.composer.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.composer.disabled :deep(.mu-input.is-disabled) {
  opacity: 1;
}

.composer-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: default;
}

.composer-pickers {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.composer-stop {
  flex: none;
  margin-left: auto;
}

.composer-send {
  flex: none;
  margin-left: auto;
}

.composer-stop + .composer-send {
  margin-left: 4px;
}
</style>
