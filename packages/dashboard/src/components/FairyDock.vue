<script setup lang="ts">
import { Button, Dropdown, type DropdownOption, Input, Modal, Popover, Select, Spin, Tag, Tooltip, useToast } from '@mushinjs/ui'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call } from '../api'
import { type ChatItem, EFFORTS, useFairyStore } from '../stores/fairy'
import { type Recommendation, useFairySceneStore } from '../stores/fairyScene'
import { modelCapabilities, providerOptions as toProviderOptions } from '../models'
import { useDataStore } from '../stores/data'
import type { FairySkill } from '../types'
import { pretty } from '../utils'
import FairyMessage from './fairy/FairyMessage.vue'
import FairyToolCall from './fairy/FairyToolCall.vue'
import CommandPalette, { type PaletteItem } from './fairy/CommandPalette.vue'
import HistoryDrawer from './fairy/HistoryDrawer.vue'
import PanelIcon from './flow/editor/PanelIcon.vue'
import ModelSelect from './ModelSelect.vue'

/** `mode` is set where Fairy can float or dock; the button switches between the two. */
defineProps<{ closable?: boolean; mode?: 'docked' | 'floating' }>()
const emit = defineEmits<{ close: []; toggleMode: [] }>()

const { t } = useI18n()
const router = useRouter()
const fairy = useFairyStore()
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

const showPicker = ref(false)
const modelQuery = ref('')
const pickerLabel = computed(() => {
  const model = fairy.choice.model
    || (fairy.choice.provider ? data.providers.find((item) => item.id === fairy.choice.provider)?.defaultModel ?? data.profiles.find((item) => item.id === fairy.choice.provider)?.name : undefined)
    || t('fairyPicker.default')
  return fairy.choice.effort ? `${model} · ${t(`fairyPicker.efforts.${fairy.choice.effort}`)}` : model
})

/** Chat providers with their models, newest first as fetched, filtered by the search words. */
const modelGroups = computed(() => {
  const query = modelQuery.value.trim().toLowerCase()
  return data.providers
    .filter((provider) => provider.capabilities?.includes('chat') ?? true)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: (provider.models.length ? provider.models : provider.defaultModel ? [provider.defaultModel] : [])
        .filter((model) => !query || model.toLowerCase().includes(query) || provider.name.toLowerCase().includes(query)),
    }))
    .filter((group) => group.models.length)
})
const modelCount = computed(() => data.providers.reduce((sum, provider) => sum + provider.models.length, 0))

/** Whether the picked model reasons; the name is all there is to go by, so an unknown model counts as one. */
const supportsEffort = computed(() => !fairy.choice.model || modelCapabilities(fairy.choice.model).includes('reasoning'))

function changeModel() {
  showPicker.value = true
}

/** 0 is the default effort, then one step per level. */
const effortStep = computed(() => (fairy.choice.effort ? EFFORTS.indexOf(fairy.choice.effort) + 1 : 0))
function setEffortStep(step: number) {
  fairy.choice = { ...fairy.choice, effort: step ? EFFORTS[step - 1] : undefined }
}

function pickModel(provider?: string, model?: string) {
  fairy.choice = { ...fairy.choice, provider, model }
  showPicker.value = false
}

watch(showPicker, (open) => {
  if (!open) modelQuery.value = ''
})

const ALL = '__all__'
const sessionOptions = computed<DropdownOption[]>(() => [
  ...fairy.sessions.slice(0, 8).map((session) => ({ label: session.title || t('fairy.untitled'), key: session.id, icon: session.id === fairy.current ? 'i-lucide-check' : 'i-lucide-message-square' })),
  ...(fairy.sessions.length ? [{ type: 'divider' as const }, { label: t('fairyHistory.all'), key: ALL, icon: 'i-lucide-history' }] : []),
])

function pickSession(id: string) {
  if (id === ALL) showHistory.value = true
  else fairy.load(id)
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

async function send(text = input.value) {
  if ((!text.trim() && !picked.value.length && !fairy.quote) || fairy.running) return
  const skills = picked.value
  const scene = { ...scenes.scene }
  const bot = commandBot.value
  if (bot && text.trim().startsWith(`/${bot.name}`)) scene.state = { ...scene.state, commandBot: bot.bot }
  input.value = ''
  picked.value = []
  commandBot.value = undefined
  await fairy.send(text.trim(), { skills, scene })
}

async function sendRecommendation(item: Recommendation) {
  const skill = item.skill ? fairy.skills.find((entry) => entry.id === item.skill && entry.enabled) : undefined
  scenes.dismiss(item.id)
  if (fairy.running) return
  await fairy.send(item.prompt, { skills: skill ? [skill] : [], scene: scenes.scene })
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

const showModel = ref(false)
const modelForm = ref<{ provider?: string; model?: string }>({})

function runBuiltin(name: string) {
  switch (name) {
    case 'new':
    case 'clear':
      fairy.newChat()
      picked.value = []
      break
    case 'history':
      showHistory.value = true
      break
    case 'model':
      openModel().catch(() => {})
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

const providerOptions = computed(() => toProviderOptions(data.providers, data.profiles, t, { markDefault: true }))

async function openModel() {
  const plugins = await call<{ id: string; package: string; config: Record<string, any> }[]>('plugins.list')
  const entry = plugins.find((plugin) => plugin.package === '@mushinjs/plugin-fairy')
  modelForm.value = { provider: entry?.config.provider, model: entry?.config.model }
  showModel.value = true
}

async function saveModel() {
  const plugins = await call<{ id: string; package: string; config: Record<string, any> }[]>('plugins.list')
  const entry = plugins.find((plugin) => plugin.package === '@mushinjs/plugin-fairy')
  if (!entry) return
  const config = { ...entry.config, provider: modelForm.value.provider || undefined, model: modelForm.value.model || undefined }
  await call('plugins.configure', { id: entry.id, config })
  showModel.value = false
  fairy.note(t('fairyPalette.modelSaved', { model: modelForm.value.model || t('common.default') }))
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
    if (run.length >= GROUP_FROM && !run.some((call) => call.state === 'confirm')) {
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

async function scrollToEnd() {
  await nextTick()
  list.value?.scrollTo({ top: list.value.scrollHeight })
}

watch(() => [fairy.items.length, fairy.streaming, fairy.items.at(-1)], scrollToEnd, { deep: true })
</script>

<template>
  <div class="dock-inner">
    <header class="dock-head">
      <div class="dock-title">
        <span class="i-lucide-sparkles text-[18px]" />
        <span>{{ t('nav.fairy') }}</span>
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
        <Dropdown v-if="fairy.sessions.length" :options="sessionOptions" align="end" @select="pickSession">
          <Button size="small" quaternary>{{ t('fairy.history') }}</Button>
        </Dropdown>
        <Tooltip v-if="fairy.current">
          <template #trigger>
            <Button size="small" quaternary circle :aria-label="t('fairy.deleteChat')" icon="i-lucide-trash-2" @click="fairy.remove(fairy.current!)" />
          </template>
          {{ t('fairy.deleteChat') }}
        </Tooltip>
        <Tooltip>
          <template #trigger>
            <Button size="small" quaternary circle :aria-label="t('fairy.newChat')" icon="i-lucide-plus" @click="fairy.newChat()" />
          </template>
          {{ t('fairy.newChat') }}
        </Tooltip>
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

    <div ref="list" class="dock-list">
      <div v-if="data.loadedProviders && !data.providers.length" class="dock-empty">
        <p>{{ t('fairy.needProvider') }}</p>
        <Button type="primary" @click="router.push('/setup')">{{ t('fairy.goSetup') }}</Button>
      </div>

      <div v-else-if="!fairy.items.length && !fairy.running" class="dock-empty">
        <p class="dock-hello">{{ scenes.welcome ?? t('fairy.hello') }}</p>
        <button v-for="item in scenes.recommendations" :key="item.id" class="suggestion" :class="{ urgent: item.urgent }" type="button" @click="sendRecommendation(item)">
          <span>{{ item.text }}</span>
          <Tag v-if="item.skill" size="tiny" class="suggestion-skill">
            <template #icon><span class="i-lucide-puzzle" /></template>
            {{ fairy.skills.find((skill) => skill.id === item.skill)?.name ?? item.skill }}
          </Tag>
        </button>
        <p class="dock-tip">{{ t('fairyPalette.tip') }}</p>
      </div>

      <template v-for="(row, index) in rows" :key="index">
        <div v-if="row.kind === 'group'" class="tool-group" :class="{ open: expanded.has(row.key) }">
          <button class="group-row" type="button" @click="toggle(row.key)">
            <Spin v-if="row.running" :size="14" />
            <span v-else-if="!row.failed" class="i-lucide-circle-check" color="var(--ok)" />
            <span v-else-if="row.failed === row.items.length" class="i-lucide-circle-x" color="var(--bad)" />
            <span v-else class="i-lucide-circle-alert" color="var(--warn)" />
            <span class="mono group-name">{{ row.action }}</span>
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
              @toggle="toggle(item.id)"
              @confirm="(approved) => fairy.confirm(item.id, approved)"
            />
          </template>
        </template>
      </template>

      <div v-for="ask in fairy.asks" :key="ask.id" class="ask">
        <div class="ask-question"><span class="i-lucide-circle-help" />{{ ask.question }}</div>
        <button
          v-for="(option, optionIndex) in ask.options"
          :key="optionIndex"
          type="button"
          class="ask-option"
          :class="{ recommended: ask.recommended === optionIndex }"
          @click="fairy.answer(ask.id, { choice: optionIndex })"
        >
          <span class="ask-label">
            {{ option.label }}
            <Tag v-if="ask.recommended === optionIndex" size="tiny" type="success">{{ t('fairyPalette.recommended') }}</Tag>
          </span>
          <span v-if="option.description" class="ask-desc">{{ option.description }}</span>
        </button>
        <Input
          v-if="ask.allowOther"
          size="small"
          :placeholder="t('fairyMessage.other')"
          @keydown.enter="(event: KeyboardEvent) => { const value = (event.target as HTMLInputElement).value.trim(); if (value) fairy.answer(ask.id, { other: value }) }"
        />
      </div>

      <div v-if="fairy.streaming" class="msg assistant streaming"><FairyMessage :text="fairy.streaming" streaming /></div>
      <div v-else-if="fairy.running" class="thinking"><Spin :size="14" /> {{ t('fairy.thinking') }}</div>
    </div>

    <div v-if="fairy.toolsStale && fairy.items.length" class="stale">
      <span>{{ t('fairyMessage.toolsStale') }}</span>
      <Button size="tiny" secondary @click="fairy.newChat()">{{ t('fairy.newChat') }}</Button>
    </div>

    <div v-if="fairy.items.length && scenes.banner && !fairy.running" class="banner">
      <span class="i-lucide-info" color="var(--warn)" />
      <button type="button" class="banner-text" @click="sendRecommendation(scenes.banner!)">{{ scenes.banner.text }}</button>
      <Button size="tiny" quaternary circle :aria-label="t('fairy.close')" icon="i-lucide-x" @click="scenes.dismiss(scenes.banner!.id)" />
    </div>

    <footer class="dock-input" data-fairy-target="fairy.input">
      <CommandPalette
        v-if="trigger"
        ref="palette"
        class="dock-palette"
        :mode="trigger.mode"
        :query="trigger.query"
        :scene="scenes.key"
        @pick="onPick"
      />
      <div class="input-box">
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
          v-model:value="input"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 6 }"
          :placeholder="t('fairy.placeholder')"
          :disabled="!data.providers.length"
          @keydown="onKeydown"
        />
        <div class="input-tools">
          <Popover v-model:show="showPicker" placement="top" align="end" :padded="false" :width="300">
            <template #trigger>
              <button type="button" class="picker-chip" :title="t('fairyPicker.title')">
                <span class="picker-label">{{ pickerLabel }}</span>
                <span class="i-lucide-chevron-down picker-caret" />
              </button>
            </template>
            <div class="picker">
              <div class="picker-effort">
                <div class="picker-row">
                  <span class="picker-title">{{ t('fairyPicker.effort') }}</span>
                  <span class="picker-value">{{ t(`fairyPicker.efforts.${fairy.choice.effort ?? 'default'}`) }}</span>
                </div>
                <div class="effort-track" :class="{ disabled: !supportsEffort }" :style="{ '--fill': `${(effortStep / EFFORTS.length) * 100}%` }">
                  <button
                    v-for="step in EFFORTS.length + 1"
                    :key="step"
                    type="button"
                    class="effort-stop"
                    :class="{ on: step - 1 <= effortStep, current: step - 1 === effortStep }"
                    :style="{ left: `${((step - 1) / EFFORTS.length) * 100}%` }"
                    :aria-label="t(`fairyPicker.efforts.${step === 1 ? 'default' : EFFORTS[step - 2]}`)"
                    :title="t(`fairyPicker.efforts.${step === 1 ? 'default' : EFFORTS[step - 2]}`)"
                    @click="setEffortStep(step - 1)"
                  />
                </div>
                <div class="effort-ends">
                  <span>{{ t('fairyPicker.efforts.default') }}</span>
                  <span>{{ t('fairyPicker.efforts.max') }}</span>
                </div>
                <p v-if="!supportsEffort" class="effort-off">{{ t('fairyPicker.noEffort') }}</p>
              </div>
              <div class="picker-models">
                <input v-if="modelCount > 8" v-model="modelQuery" class="picker-search" :placeholder="t('fairyPicker.search')">
                <button type="button" class="model-item" :class="{ current: !fairy.choice.provider && !fairy.choice.model }" @click="pickModel()">
                  <span class="model-name">{{ t('fairyPicker.default') }}<small>{{ t('fairyPicker.defaultHint') }}</small></span>
                  <span v-if="!fairy.choice.provider && !fairy.choice.model" class="i-lucide-check" />
                </button>
                <template v-for="group in modelGroups" :key="group.id">
                  <div class="model-group">{{ group.name }}</div>
                  <button
                    v-for="model in group.models"
                    :key="model"
                    type="button"
                    class="model-item"
                    :class="{ current: fairy.choice.provider === group.id && fairy.choice.model === model }"
                    @click="pickModel(group.id, model)"
                  >
                    <span class="model-name">{{ model }}</span>
                    <span v-if="fairy.choice.provider === group.id && fairy.choice.model === model" class="i-lucide-check" />
                  </button>
                </template>
                <div v-if="!modelGroups.length && modelQuery" class="model-empty">{{ t('fairyPicker.noMatch') }}</div>
              </div>
              <p class="picker-hint">{{ t('fairyPicker.hint') }}</p>
            </div>
          </Popover>
        </div>
      </div>
      <Button v-if="fairy.running" type="warning" secondary :aria-label="t('fairy.stop')" icon="i-lucide-circle-stop" @click="fairy.cancel()" />
      <Button v-else type="primary" :disabled="!input.trim() && !picked.length && !fairy.quote" :aria-label="t('fairy.send')" icon="i-lucide-send" @click="send()" />
    </footer>

    <HistoryDrawer v-model:show="showHistory" />
    <Modal v-model:show="showModel" :title="t('fairyPalette.modelTitle')" :style="{ width: '400px' }">
      <div class="model-form">
        <Select v-model:value="modelForm.provider" clearable :options="providerOptions" :placeholder="t('fairyPalette.defaultProvider')" />
        <ModelSelect :model-value="modelForm.model" :provider="modelForm.provider" :placeholder="t('fairyPalette.defaultModel')" @update:model-value="(value) => (modelForm.model = value ?? undefined)" />
        <Button type="primary" @click="saveModel">{{ t('common.save') }}</Button>
      </div>
    </Modal>
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
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid rgba(127, 127, 127, 0.18);
}

.dock-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.dock-actions {
  display: flex;
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
  gap: 10px;
}

.dock-empty {
  margin: auto 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: stretch;
  text-align: center;
}

.dock-hello {
  opacity: 0.75;
  line-height: 1.6;
  margin: 0 0 8px;
}

.suggestion {
  text-align: left;
  font: inherit;
  font-size: 13px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(127, 127, 127, 0.25);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.suggestion:hover {
  border-color: var(--primary);
}

.suggestion {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}

.suggestion.urgent {
  border-color: rgba(240, 160, 32, 0.6);
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
  border: 1px solid rgba(127, 127, 127, 0.3);
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

.ask {
  border: 1px solid var(--primary);
  border-radius: 10px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ask-question {
  display: flex;
  gap: 6px;
  align-items: center;
  font-weight: 500;
}

.ask-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  font: inherit;
  font-size: 13px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(127, 127, 127, 0.25);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.ask-option:hover,
.ask-option.recommended {
  border-color: var(--primary);
}

.ask-label {
  display: flex;
  gap: 6px;
  align-items: center;
}

.ask-desc {
  font-size: 12px;
  opacity: 0.65;
}

.stale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 12px 6px;
  font-size: 12px;
  opacity: 0.8;
}

.banner {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px;
  padding: 6px 8px 6px 10px;
  border-radius: 8px;
  background: rgba(240, 160, 32, 0.1);
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

.input-box {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
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
  border-left: 2px solid rgba(127, 127, 127, 0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dock-palette {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(100% - 4px);
  z-index: 10;
}

.model-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
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

.input-tools {
  display: flex;
  justify-content: flex-end;
}

.picker-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  padding: 2px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg3);
  font-size: 12px;
  cursor: pointer;
}

.picker-chip:hover,
.picker-chip[data-state='open'] {
  background: var(--s2);
  color: var(--fg);
}

.picker-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-caret {
  flex: none;
  font-size: 12px;
}

.picker {
  display: flex;
  flex-direction: column;
  font-size: 13px;
}

.picker-effort {
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--line);
}

.picker-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12px;
}

.picker-title {
  color: var(--fg2);
}

.picker-value {
  color: var(--fg);
  font-weight: 500;
}

.effort-track {
  position: relative;
  height: 4px;
  margin: 0 7px;
  border-radius: 2px;
  background: linear-gradient(to right, var(--primary) var(--fill), var(--line-strong) var(--fill));
}

.effort-stop {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 10px;
  padding: 0;
  border: 2px solid var(--line-strong);
  border-radius: 50%;
  background: var(--s1);
  transform: translate(-50%, -50%);
  cursor: pointer;
}

.effort-stop::before {
  content: '';
  position: absolute;
  inset: -8px;
}

.effort-stop.on {
  border-color: var(--primary);
  background: var(--primary);
}

.effort-stop.current {
  width: 14px;
  height: 14px;
  background: var(--s1);
}

.effort-track.disabled {
  opacity: 0.4;
  pointer-events: none;
}

.effort-off {
  margin: 8px 0 0;
  color: var(--warn);
  font-size: 11px;
}

.effort-ends {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  color: var(--fg3);
  font-size: 11px;
}

.picker-models {
  display: flex;
  flex-direction: column;
  max-height: 280px;
  padding: 6px;
  overflow-y: auto;
}

.picker-search {
  margin: 0 0 6px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  outline: none;
}

.picker-search:focus {
  border-color: var(--primary);
}

.model-group {
  padding: 8px 8px 4px;
  color: var(--fg3);
  font-size: 11px;
}

.model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.model-item:hover {
  background: var(--s2);
}

.model-item .i-lucide-check {
  flex: none;
  color: var(--primary);
}

.model-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-name small {
  color: var(--fg3);
  font-size: 11px;
}

.model-empty {
  padding: 8px;
  color: var(--fg3);
}

.picker-hint {
  margin: 0;
  padding: 8px 14px 10px;
  border-top: 1px solid var(--line);
  color: var(--fg3);
  font-size: 11px;
}

.msg.user {
  align-self: flex-end;
  background: var(--primary);
  color: #fff;
  border-bottom-right-radius: 4px;
}

.msg.assistant {
  align-self: flex-start;
  background: rgba(127, 127, 127, 0.12);
  border-bottom-left-radius: 4px;
}

.msg.assistant {
  white-space: normal;
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
  background: rgba(208, 48, 80, 0.08);
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
  background: rgba(127, 127, 127, 0.1);
}

.msg.limit span {
  flex: 1;
}

.tool-group {
  border: 1px solid rgba(127, 127, 127, 0.2);
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
  position: relative;
  display: flex;
  gap: 8px;
  align-items: flex-end;
  padding: 12px;
  border-top: 1px solid rgba(127, 127, 127, 0.18);
}
</style>
