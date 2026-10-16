<script setup lang="ts">
import {
  AddOutline, AlertCircleOutline, CheckmarkCircle, CloseCircleOutline, CloseOutline, HandLeftOutline, SendOutline,
  SparklesOutline, StopCircleOutline, TrashOutline,
} from '@vicons/ionicons5'
import { NButton, NIcon, NInput, NPopselect, NSpin, NTag, NTooltip } from 'naive-ui'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAgentStore } from '../stores/agent'
import { useDataStore } from '../stores/data'
import { pretty } from '../utils'

defineProps<{ closable?: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const router = useRouter()
const agent = useAgentStore()
const data = useDataStore()

const input = ref('')
const list = ref<HTMLElement>()
const expanded = ref(new Set<string>())

const suggestions = computed(() => [t('agent.suggest.connect'), t('agent.suggest.status'), t('agent.suggest.provider')])

const sessionOptions = computed(() => agent.sessions.map((session) => ({
  label: session.title || t('agent.untitled'),
  value: session.id,
})))

async function send(text = input.value) {
  if (!text.trim() || agent.running) return
  input.value = ''
  await agent.send(text.trim())
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
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
      </div>
      <div class="dock-actions">
        <NPopselect
          v-if="sessionOptions.length"
          :value="agent.current"
          :options="sessionOptions"
          scrollable
          trigger="click"
          @update:value="(id: string) => agent.load(id)"
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
        <button v-for="text in suggestions" :key="text" class="suggestion" type="button" @click="send(text)">
          {{ text }}
        </button>
      </div>

      <template v-for="(item, index) in agent.items" :key="index">
        <div v-if="item.kind === 'user'" class="msg user">{{ item.text }}</div>
        <div v-else-if="item.kind === 'assistant'" class="msg assistant">{{ item.text }}</div>
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

    <footer class="dock-input" data-agent-target="agent.input">
      <NInput
        v-model:value="input"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 6 }"
        :placeholder="t('agent.placeholder')"
        :disabled="!data.providers.length"
        @keydown="onKeydown"
      />
      <NButton v-if="agent.running" type="warning" secondary :aria-label="t('agent.stop')" @click="agent.cancel()">
        <template #icon><NIcon><StopCircleOutline /></NIcon></template>
      </NButton>
      <NButton v-else type="primary" :disabled="!input.trim()" :aria-label="t('agent.send')" @click="send()">
        <template #icon><NIcon><SendOutline /></NIcon></template>
      </NButton>
    </footer>
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
  display: flex;
  gap: 8px;
  align-items: flex-end;
  padding: 12px;
  border-top: 1px solid rgba(127, 127, 127, 0.18);
}
</style>
