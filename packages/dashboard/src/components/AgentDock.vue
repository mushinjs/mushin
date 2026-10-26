<script setup lang="ts">
import {
  AddOutline, AlertCircleOutline, CheckmarkCircle, CloseCircleOutline, CloseOutline, ExtensionPuzzleOutline, HandLeftOutline,
  InformationCircleOutline, SendOutline, SparklesOutline, StopCircleOutline, TrashOutline,
} from '@vicons/ionicons5'
import { NButton, NIcon, NInput, NModal, NPopover, NPopselect, NSelect, NSpin, NTag, NTooltip } from 'naive-ui'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call } from '../api'
import { useAgentStore } from '../stores/agent'
import { type Recommendation, useAgentSceneStore } from '../stores/agentScene'
import { useDataStore } from '../stores/data'
import type { AgentSkill } from '../types'
import { pretty } from '../utils'
import CommandPalette, { type PaletteItem } from './agent/CommandPalette.vue'
import HistoryDrawer from './agent/HistoryDrawer.vue'

defineProps<{ closable?: boolean }>()
const emit = defineEmits<{ close: [] }>()

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
const sessionOptions = computed(() => [
  ...agent.sessions.slice(0, 8).map((session) => ({ label: session.title || t('agent.untitled'), value: session.id })),
  ...(agent.sessions.length ? [{ label: t('agentHistory.all'), value: ALL }] : []),
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
  if ((!text.trim() && !picked.value.length) || agent.running) return
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

const providerOptions = computed(() => data.providers.map((provider) => ({ label: provider.name, value: provider.id })))
const modelOptions = computed(() => {
  const provider = data.providers.find((item) => item.id === modelForm.value.provider) ?? data.providers.find((item) => item.isDefault)
  return (provider?.models ?? []).map((model) => ({ label: model, value: model }))
})

async function openModel() {
  const plugins = await call<{ id: string; package: string; config: Record<string, any> }[]>('plugins.list')
  const entry = plugins.find((plugin) => plugin.package === '@mushin/plugin-agent')
  modelForm.value = { provider: entry?.config.provider, model: entry?.config.model }
  showModel.value = true
}

async function saveModel() {
  const plugins = await call<{ id: string; package: string; config: Record<string, any> }[]>('plugins.list')
  const entry = plugins.find((plugin) => plugin.package === '@mushin/plugin-agent')
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
        <NIcon size="18"><SparklesOutline /></NIcon>
        <span>{{ t('nav.agent') }}</span>
        <NPopover trigger="click" placement="bottom-start" :style="{ maxWidth: '300px' }">
          <template #trigger>
            <button type="button" class="scene-tag" :title="t('agentScene.whatHere')" data-agent-target="agent.scene">
              {{ scenes.scene.label }}
            </button>
          </template>
          <div class="scene-pop">
            <div class="scene-pop-title">{{ t('agentScene.whatHere') }}</div>
            <p>{{ scenes.scene.hint }}</p>
          </div>
        </NPopover>
      </div>
      <div class="dock-actions">
        <NPopselect
          v-if="agent.sessions.length"
          :value="agent.current"
          :options="sessionOptions"
          trigger="click"
          @update:value="pickSession"
        >
          <NButton size="small" quaternary>{{ t('agent.history') }}</NButton>
        </NPopselect>
        <NTooltip v-if="agent.current">
          <template #trigger>
            <NButton size="small" quaternary circle :aria-label="t('agent.deleteChat')" @click="agent.remove(agent.current!)">
              <template #icon><NIcon><TrashOutline /></NIcon></template>
            </NButton>
          </template>
          {{ t('agent.deleteChat') }}
        </NTooltip>
        <NTooltip>
          <template #trigger>
            <NButton size="small" quaternary circle :aria-label="t('agent.newChat')" @click="agent.newChat()">
              <template #icon><NIcon><AddOutline /></NIcon></template>
            </NButton>
          </template>
          {{ t('agent.newChat') }}
        </NTooltip>
        <NButton v-if="closable" size="small" quaternary circle :aria-label="t('agent.close')" @click="emit('close')">
          <template #icon><NIcon><CloseOutline /></NIcon></template>
        </NButton>
      </div>
    </header>

    <div ref="list" class="dock-list">
      <div v-if="data.loadedProviders && !data.providers.length" class="dock-empty">
        <p>{{ t('agent.needProvider') }}</p>
        <NButton type="primary" @click="router.push('/setup')">{{ t('agent.goSetup') }}</NButton>
      </div>

      <div v-else-if="!agent.items.length && !agent.running" class="dock-empty">
        <p class="dock-hello">{{ t('agent.hello') }}</p>
        <button v-for="item in scenes.recommendations" :key="item.id" class="suggestion" :class="{ urgent: item.urgent }" type="button" @click="sendRecommendation(item)">
          <span>{{ item.text }}</span>
          <NTag v-if="item.skill" size="tiny" :bordered="false" class="suggestion-skill">
            <template #icon><NIcon><ExtensionPuzzleOutline /></NIcon></template>
            {{ agent.skills.find((skill) => skill.id === item.skill)?.name ?? item.skill }}
          </NTag>
        </button>
        <p class="dock-tip">{{ t('agentPalette.tip') }}</p>
      </div>

      <template v-for="(item, index) in agent.items" :key="index">
        <div v-if="item.kind === 'user'" class="msg user">
          <div v-if="item.skills?.length" class="msg-skills">
            <span v-for="name in item.skills" :key="name" class="msg-skill"><NIcon><ExtensionPuzzleOutline /></NIcon>{{ name }}</span>
          </div>
          {{ item.text }}
        </div>
        <div v-else-if="item.kind === 'assistant'" class="msg assistant">{{ item.text }}</div>
        <div v-else-if="item.kind === 'note'" class="msg note">
          <NIcon><InformationCircleOutline /></NIcon><span>{{ item.text }}</span>
        </div>
        <div v-else-if="item.kind === 'error'" class="msg error">
          <NIcon><AlertCircleOutline /></NIcon> {{ item.text }}
        </div>
        <div v-else class="tool" :class="item.state">
          <button class="tool-row" type="button" @click="toggle(item.id)">
            <NSpin v-if="item.state === 'running'" :size="14" />
            <NIcon v-else-if="item.state === 'ok'" color="#18a058"><CheckmarkCircle /></NIcon>
            <NIcon v-else-if="item.state === 'confirm'" color="#f0a020"><HandLeftOutline /></NIcon>
            <NIcon v-else color="#d03050"><CloseCircleOutline /></NIcon>
            <span class="mono tool-name">{{ item.action }}</span>
            <NTag v-if="item.risk === 'dangerous'" size="tiny" type="error" :bordered="false">{{ t('agent.dangerous') }}</NTag>
            <span class="tool-state">{{ t(`agent.state.${item.state}`) }}</span>
          </button>
          <div v-if="item.state === 'confirm'" class="confirm">
            <p>{{ t('agent.confirmText', { action: item.action }) }}</p>
            <pre class="json mono">{{ pretty(item.input) }}</pre>
            <div class="confirm-actions">
              <NButton size="small" type="error" @click="agent.confirm(item.id, true)">{{ t('agent.approve') }}</NButton>
              <NButton size="small" @click="agent.confirm(item.id, false)">{{ t('agent.deny') }}</NButton>
            </div>
          </div>
          <div v-else-if="expanded.has(item.id)" class="tool-detail">
            <div class="label">{{ t('agent.input') }}</div>
            <pre class="json mono">{{ pretty(item.input) }}</pre>
            <template v-if="item.result !== undefined || item.error">
              <div class="label">{{ t('agent.output') }}</div>
              <pre class="json mono">{{ item.error ?? pretty(item.result) }}</pre>
            </template>
          </div>
        </div>
      </template>

      <div v-if="agent.streaming" class="msg assistant streaming">{{ agent.streaming }}</div>
      <div v-else-if="agent.running" class="thinking"><NSpin :size="14" /> {{ t('agent.thinking') }}</div>
    </div>

    <div v-if="agent.items.length && scenes.banner && !agent.running" class="banner">
      <NIcon color="#f0a020"><InformationCircleOutline /></NIcon>
      <button type="button" class="banner-text" @click="sendRecommendation(scenes.banner!)">{{ scenes.banner.text }}</button>
      <NButton size="tiny" quaternary circle :aria-label="t('agent.close')" @click="scenes.dismiss(scenes.banner!.id)">
        <template #icon><NIcon><CloseOutline /></NIcon></template>
      </NButton>
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
        <div v-if="picked.length" class="chips">
          <NTag v-for="skill in picked" :key="skill.id" size="small" type="success" closable :bordered="false" @close="picked = picked.filter((item) => item.id !== skill.id)">
            <template #icon><NIcon><ExtensionPuzzleOutline /></NIcon></template>
            {{ skill.name }}
          </NTag>
        </div>
        <NInput
          v-model:value="input"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 6 }"
          :placeholder="t('agent.placeholder')"
          :disabled="!data.providers.length"
          @keydown="onKeydown"
        />
      </div>
      <NButton v-if="agent.running" type="warning" secondary :aria-label="t('agent.stop')" @click="agent.cancel()">
        <template #icon><NIcon><StopCircleOutline /></NIcon></template>
      </NButton>
      <NButton v-else type="primary" :disabled="!input.trim() && !picked.length" :aria-label="t('agent.send')" @click="send()">
        <template #icon><NIcon><SendOutline /></NIcon></template>
      </NButton>
    </footer>

    <HistoryDrawer v-model:show="showHistory" />
    <NModal v-model:show="showModel" preset="card" :title="t('agentPalette.modelTitle')" :style="{ width: '400px' }">
      <div class="model-form">
        <NSelect v-model:value="modelForm.provider" clearable :options="providerOptions" :placeholder="t('agentPalette.defaultProvider')" />
        <NSelect v-model:value="modelForm.model" clearable filterable tag :options="modelOptions" :placeholder="t('agentPalette.defaultModel')" />
        <NButton type="primary" @click="saveModel">{{ t('common.save') }}</NButton>
      </div>
    </NModal>
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
  border-color: #7c8bd9;
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
  border-color: #7c8bd9;
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
  background: rgba(124, 139, 217, 0.1);
  display: flex;
  gap: 6px;
  align-items: flex-start;
}

.msg.note .n-icon {
  margin-top: 4px;
  flex: none;
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
  background: #3b4a8c;
  color: #fff;
  border-bottom-right-radius: 4px;
}

.msg.assistant {
  align-self: flex-start;
  background: rgba(127, 127, 127, 0.12);
  border-bottom-left-radius: 4px;
}

.msg.streaming::after {
  content: '▍';
  opacity: 0.6;
  animation: blink 1s steps(2) infinite;
}

.msg.error {
  align-self: stretch;
  max-width: none;
  color: #d03050;
  background: rgba(208, 48, 80, 0.08);
  display: flex;
  align-items: center;
  gap: 6px;
}

@keyframes blink {
  50% { opacity: 0; }
}

.tool {
  border: 1px solid rgba(127, 127, 127, 0.2);
  border-radius: 8px;
  font-size: 13px;
}

.tool.confirm {
  border-color: #f0a020;
}

.tool-row {
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

.tool-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-state {
  opacity: 0.6;
  font-size: 12px;
}

.tool-detail,
.confirm {
  padding: 0 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.confirm p {
  margin: 0;
}

.confirm-actions {
  display: flex;
  gap: 8px;
}

.label {
  font-size: 12px;
  opacity: 0.6;
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
