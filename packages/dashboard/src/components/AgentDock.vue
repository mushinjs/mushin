<script setup lang="ts">
import { Button, Dropdown, type DropdownOption, Input, Modal, Popover, Select, Spin, Tag, Tooltip } from '@mushinjs/ui'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call } from '../api'
import { type ChatItem, useAgentStore } from '../stores/agent'
import { type Recommendation, useAgentSceneStore } from '../stores/agentScene'
import { providerOptions as toProviderOptions } from '../models'
import { useDataStore } from '../stores/data'
import type { AgentSkill } from '../types'
import { pretty } from '../utils'
import AgentMessage from './agent/AgentMessage.vue'
import AgentToolCall from './agent/AgentToolCall.vue'
import CommandPalette, { type PaletteItem } from './agent/CommandPalette.vue'
import HistoryDrawer from './agent/HistoryDrawer.vue'
import PanelIcon from './flow/editor/PanelIcon.vue'
import ModelSelect from './ModelSelect.vue'

/** `mode` is set where the Agent can float or dock; the button switches between the two. */
defineProps<{ closable?: boolean; mode?: 'docked' | 'floating' }>()
const emit = defineEmits<{ close: []; toggleMode: [] }>()

const { t } = useI18n()
const router = useRouter()
const agent = useAgentStore()
const scenes = useAgentSceneStore()
const data = useDataStore()

const input = ref('')
const list = ref<HTMLElement>()
const expanded = ref(new Set<string>())
const picked = ref<AgentSkill[]>([])
/** The bot of a bot command picked with `/`, told to the Agent with the next message. */
const commandBot = ref<{ name: string; bot: string }>()
const palette = ref<InstanceType<typeof CommandPalette>>()
const paletteClosed = ref(false)
const showHistory = ref(false)

const ALL = '__all__'
const sessionOptions = computed<DropdownOption[]>(() => [
  ...agent.sessions.slice(0, 8).map((session) => ({ label: session.title || t('agent.untitled'), key: session.id, icon: session.id === agent.current ? 'i-lucide-check' : 'i-lucide-message-square' })),
  ...(agent.sessions.length ? [{ type: 'divider' as const }, { label: t('agentHistory.all'), key: ALL, icon: 'i-lucide-history' }] : []),
])

function pickSession(id: string) {
  if (id === ALL) showHistory.value = true
  else agent.load(id)
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
  if ((!text.trim() && !picked.value.length && !agent.quote) || agent.running) return
  const skills = picked.value
  const scene = { ...scenes.scene }
  const bot = commandBot.value
  if (bot && text.trim().startsWith(`/${bot.name}`)) scene.state = { ...scene.state, commandBot: bot.bot }
  input.value = ''
  picked.value = []
  commandBot.value = undefined
  await agent.send(text.trim(), { skills, scene })
}

async function sendRecommendation(item: Recommendation) {
  const skill = item.skill ? agent.skills.find((entry) => entry.id === item.skill && entry.enabled) : undefined
  scenes.dismiss(item.id)
  if (agent.running) return
  await agent.send(item.prompt, { skills: skill ? [skill] : [], scene: scenes.scene })
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
      agent.newChat()
      picked.value = []
      break
    case 'history':
      showHistory.value = true
      break
    case 'model':
      openModel().catch(() => {})
      break
    case 'status': {
      const chars = agent.items.reduce((sum, item) => sum + ('text' in item ? item.text.length : JSON.stringify(item.input ?? '').length + JSON.stringify(item.result ?? '').length), 0)
      agent.note(t('agentPalette.statusText', {
        messages: agent.items.filter((item) => item.kind === 'user' || item.kind === 'assistant').length,
        chars,
        input: agent.usage?.inputTokens ?? '—',
        output: agent.usage?.outputTokens ?? '—',
        scene: scenes.scene.label,
      }))
      break
    }
    case 'help':
      agent.note(t('agentPalette.helpText', {
        commands: agent.commands.builtin.map((command) => `/${command.name}`).join(' '),
        bots: agent.commands.bots.length,
        skills: agent.skills.filter((skill) => skill.enabled).length,
      }))
      break
  }
}

const providerOptions = computed(() => toProviderOptions(data.providers, data.profiles, t, { markDefault: true }))

async function openModel() {
  const plugins = await call<{ id: string; package: string; config: Record<string, any> }[]>('plugins.list')
  const entry = plugins.find((plugin) => plugin.package === '@mushinjs/plugin-agent')
  modelForm.value = { provider: entry?.config.provider, model: entry?.config.model }
  showModel.value = true
}

async function saveModel() {
  const plugins = await call<{ id: string; package: string; config: Record<string, any> }[]>('plugins.list')
  const entry = plugins.find((plugin) => plugin.package === '@mushinjs/plugin-agent')
  if (!entry) return
  const config = { ...entry.config, provider: modelForm.value.provider || undefined, model: modelForm.value.model || undefined }
  await call('plugins.configure', { id: entry.id, config })
  showModel.value = false
  agent.note(t('agentPalette.modelSaved', { model: modelForm.value.model || t('common.default') }))
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
  const items = agent.items
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
    ok ? t('agent.groupOk', { n: ok }) : '',
    row.failed ? t('agent.groupFailed', { n: row.failed }) : '',
    row.running ? t('agent.state.running') : '',
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

watch(() => [agent.items.length, agent.streaming, agent.items.at(-1)], scrollToEnd, { deep: true })
</script>

<template>
  <div class="dock-inner">
    <header class="dock-head">
      <div class="dock-title">
        <span class="i-lucide-sparkles text-[18px]" />
        <span>{{ t('nav.agent') }}</span>
        <Popover placement="bottom" align="start" :style="{ maxWidth: '300px' }">
          <template #trigger>
            <button type="button" class="scene-tag" :title="t('agentScene.whatHere')" data-agent-target="agent.scene">
              {{ scenes.scene.label }}
            </button>
          </template>
          <div class="scene-pop">
            <div class="scene-pop-title">{{ t('agentScene.whatHere') }}</div>
            <p>{{ scenes.scene.hint }}</p>
          </div>
        </Popover>
      </div>
      <div class="dock-actions">
        <Dropdown v-if="agent.sessions.length" :options="sessionOptions" align="end" @select="pickSession">
          <Button size="small" quaternary>{{ t('agent.history') }}</Button>
        </Dropdown>
        <Tooltip v-if="agent.current">
          <template #trigger>
            <Button size="small" quaternary circle :aria-label="t('agent.deleteChat')" icon="i-lucide-trash-2" @click="agent.remove(agent.current!)" />
          </template>
          {{ t('agent.deleteChat') }}
        </Tooltip>
        <Tooltip>
          <template #trigger>
            <Button size="small" quaternary circle :aria-label="t('agent.newChat')" icon="i-lucide-plus" @click="agent.newChat()" />
          </template>
          {{ t('agent.newChat') }}
        </Tooltip>
        <Tooltip v-if="mode">
          <template #trigger>
            <Button size="small" quaternary circle :aria-label="mode === 'docked' ? t('agent.float') : t('agent.dock')" data-agent-target="agent.mode" @click="emit('toggleMode')">
              <template #icon>
                <span v-if="mode === 'docked'" class="i-lucide-app-window" />
                <PanelIcon v-else side="right" :open="true" />
              </template>
            </Button>
          </template>
          {{ mode === 'docked' ? t('agent.float') : t('agent.dock') }}
        </Tooltip>
        <Button v-if="closable" size="small" quaternary circle :aria-label="t('agent.close')" icon="i-lucide-x" @click="emit('close')" />
      </div>
    </header>

    <div ref="list" class="dock-list">
      <div v-if="data.loadedProviders && !data.providers.length" class="dock-empty">
        <p>{{ t('agent.needProvider') }}</p>
        <Button type="primary" @click="router.push('/setup')">{{ t('agent.goSetup') }}</Button>
      </div>

      <div v-else-if="!agent.items.length && !agent.running" class="dock-empty">
        <p class="dock-hello">{{ scenes.welcome ?? t('agent.hello') }}</p>
        <button v-for="item in scenes.recommendations" :key="item.id" class="suggestion" :class="{ urgent: item.urgent }" type="button" @click="sendRecommendation(item)">
          <span>{{ item.text }}</span>
          <Tag v-if="item.skill" size="tiny" class="suggestion-skill">
            <template #icon><span class="i-lucide-puzzle" /></template>
            {{ agent.skills.find((skill) => skill.id === item.skill)?.name ?? item.skill }}
          </Tag>
        </button>
        <p class="dock-tip">{{ t('agentPalette.tip') }}</p>
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
            <AgentToolCall
              v-for="item in row.items"
              :key="item.id"
              :item="item"
              :expanded="expanded.has(item.id)"
              @toggle="toggle(item.id)"
              @confirm="(approved) => agent.confirm(item.id, approved)"
            />
          </div>
        </div>
        <template v-else>
          <template v-for="item in [row.item]" :key="index">
            <div v-if="item.kind === 'user'" class="msg user">
              <div v-if="item.skills?.length" class="msg-skills">
                <span v-for="name in item.skills" :key="name" class="msg-skill"><span class="i-lucide-puzzle" />{{ name }}</span>
              </div>
              <div v-if="item.quote" class="msg-quote"><span class="i-lucide-message-circle-more" />{{ item.quote }}</div>
              {{ item.text }}
            </div>
            <div v-else-if="item.kind === 'assistant'" class="msg assistant"><AgentMessage :text="item.text" /></div>
            <div v-else-if="item.kind === 'note'" class="msg note">
              <span class="i-lucide-info" /><span>{{ item.text }}</span>
            </div>
            <div v-else-if="item.kind === 'error' && item.code === 'max_steps'" class="msg limit">
              <span class="i-lucide-info" />
              <span>{{ t('agent.maxSteps') }}</span>
              <Button v-if="index === rows.length - 1 && !agent.running" size="small" secondary @click="send(t('agent.continuePrompt'))">{{ t('agent.continue') }}</Button>
            </div>
            <div v-else-if="item.kind === 'error'" class="msg error">
              <span class="i-lucide-circle-alert" /> {{ item.text }}
            </div>
            <AgentToolCall
              v-else
              :item="item"
              :expanded="expanded.has(item.id)"
              @toggle="toggle(item.id)"
              @confirm="(approved) => agent.confirm(item.id, approved)"
            />
          </template>
        </template>
      </template>

      <div v-for="ask in agent.asks" :key="ask.id" class="ask">
        <div class="ask-question"><span class="i-lucide-circle-help" />{{ ask.question }}</div>
        <button
          v-for="(option, optionIndex) in ask.options"
          :key="optionIndex"
          type="button"
          class="ask-option"
          :class="{ recommended: ask.recommended === optionIndex }"
          @click="agent.answer(ask.id, { choice: optionIndex })"
        >
          <span class="ask-label">
            {{ option.label }}
            <Tag v-if="ask.recommended === optionIndex" size="tiny" type="success">{{ t('agentPalette.recommended') }}</Tag>
          </span>
          <span v-if="option.description" class="ask-desc">{{ option.description }}</span>
        </button>
        <Input
          v-if="ask.allowOther"
          size="small"
          :placeholder="t('agentMessage.other')"
          @keydown.enter="(event: KeyboardEvent) => { const value = (event.target as HTMLInputElement).value.trim(); if (value) agent.answer(ask.id, { other: value }) }"
        />
      </div>

      <div v-if="agent.streaming" class="msg assistant streaming"><AgentMessage :text="agent.streaming" streaming /></div>
      <div v-else-if="agent.running" class="thinking"><Spin :size="14" /> {{ t('agent.thinking') }}</div>
    </div>

    <div v-if="agent.toolsStale && agent.items.length" class="stale">
      <span>{{ t('agentMessage.toolsStale') }}</span>
      <Button size="tiny" secondary @click="agent.newChat()">{{ t('agent.newChat') }}</Button>
    </div>

    <div v-if="agent.items.length && scenes.banner && !agent.running" class="banner">
      <span class="i-lucide-info" color="var(--warn)" />
      <button type="button" class="banner-text" @click="sendRecommendation(scenes.banner!)">{{ scenes.banner.text }}</button>
      <Button size="tiny" quaternary circle :aria-label="t('agent.close')" icon="i-lucide-x" @click="scenes.dismiss(scenes.banner!.id)" />
    </div>

    <footer class="dock-input" data-agent-target="agent.input">
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
        <div v-if="picked.length || agent.quote" class="chips">
          <Tag v-if="agent.quote" size="small" type="info" closable class="quote-chip" :title="agent.quote.label" @close="agent.quote = undefined">
            <template #icon><span class="i-lucide-message-circle-more" /></template>
            {{ t('agent.quoted', { label: agent.quote.label }) }}
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
          :placeholder="t('agent.placeholder')"
          :disabled="!data.providers.length"
          @keydown="onKeydown"
        />
      </div>
      <Button v-if="agent.running" type="warning" secondary :aria-label="t('agent.stop')" icon="i-lucide-circle-stop" @click="agent.cancel()" />
      <Button v-else type="primary" :disabled="!input.trim() && !picked.length && !agent.quote" :aria-label="t('agent.send')" icon="i-lucide-send" @click="send()" />
    </footer>

    <HistoryDrawer v-model:show="showHistory" />
    <Modal v-model:show="showModel" :title="t('agentPalette.modelTitle')" :style="{ width: '400px' }">
      <div class="model-form">
        <Select v-model:value="modelForm.provider" clearable :options="providerOptions" :placeholder="t('agentPalette.defaultProvider')" />
        <ModelSelect :model-value="modelForm.model" :provider="modelForm.provider" :placeholder="t('agentPalette.defaultModel')" @update:model-value="(value) => (modelForm.model = value ?? undefined)" />
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

.msg.streaming :deep(.agent-md > :last-child)::after {
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
  align-items: center;
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
