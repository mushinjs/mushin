<script setup lang="ts">
import { Button, Card, Dropdown, Empty, Input, Modal, Spin, Tag, useToast } from '@mushin/ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call, on } from '../api'
import { useAgentStore } from '../stores/agent'
import { useDataStore } from '../stores/data'
import type { ChannelSummary, MessageRecord } from '../types'
import { formatTime, segmentsText } from '../utils'
import MessageBubble from './MessageBubble.vue'

const props = defineProps<{ botId: string }>()
const { t } = useI18n()
const message = useToast()
const data = useDataStore()
const router = useRouter()
const agent = useAgentStore()

// ---- what to do with a message: the flows it started, a new flow from it, or quote it to the Agent ----

interface RunRow {
  id: string
  flowId: string
  flowName: string
  status: string
  startedAt: number
  error?: string
  node?: { label?: string; type: string }
}

const actionOptions = computed(() => [
  { key: 'runs', label: t('live.actionRuns') },
  { key: 'newFlow', label: t('live.actionNewFlow') },
  { key: 'agent', label: t('live.actionAgent') },
])

const runsFor = ref<MessageRecord>()
const runRows = ref<RunRow[]>([])
const loadingRuns = ref(false)

async function showRuns(record: MessageRecord) {
  runsFor.value = record
  runRows.value = []
  loadingRuns.value = true
  try {
    runRows.value = (await call<{ runs: RunRow[] }>('flows.history', { bot: props.botId, message: record.id, limit: 20 })).runs
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loadingRuns.value = false
  }
}

const openRun = (row: RunRow) => router.push({ path: `/flows/${row.flowId}`, query: { run: row.id } })
const sampleQuery = (record: MessageRecord) => `${record.botId}:${record.channel.id}:${record.id}`

/** A trigger guessed from the message: a command when it starts with one of the bot's prefixes, else a keyword. */
function guessTrigger(text: string) {
  const prefixes = bot.value?.commands?.prefixes?.filter(Boolean).length ? bot.value.commands!.prefixes! : ['/']
  const prefix = [...prefixes].sort((a, b) => b.length - a.length).find((item) => text.startsWith(item))
  const word = (prefix ? text.slice(prefix.length) : text).trim().split(/\s+/)[0] ?? ''
  if (prefix && word) return { id: 'trigger', type: 'trigger.command', config: { name: word } }
  return { id: 'trigger', type: 'trigger.keyword', config: { keywords: [word.slice(0, 20) || text.slice(0, 20)], mode: 'contains' } }
}

async function newFlow(record: MessageRecord) {
  const text = segmentsText(record.segments).trim()
  try {
    const flow = await call<{ id: string }>('flows.create', {
      name: t('live.newFlowName', { text: text.slice(0, 12) }),
      bots: [props.botId],
      nodes: [
        { ...guessTrigger(text), position: { x: 80, y: 120 } },
        { id: 'reply', type: 'action.reply', config: { text: t('live.newFlowReply') }, position: { x: 400, y: 120 } },
      ],
      edges: [{ source: 'trigger', sourceHandle: 'exec:next', target: 'reply', targetHandle: 'exec' }],
    })
    await router.push({ path: `/flows/${flow.id}`, query: { sample: sampleQuery(record) } })
  } catch (error) {
    message.error((error as Error).message)
  }
}

function quoteToAgent(record: MessageRecord) {
  agent.quote = {
    bot: props.botId,
    channel: record.channel.id,
    id: record.id,
    label: `${record.user.name ?? record.user.id}：${segmentsText(record.segments).slice(0, 40)}`,
  }
  agent.open = true
}

function onAction(key: string, record: MessageRecord) {
  if (key === 'runs') void showRuns(record)
  else if (key === 'newFlow') void newFlow(record)
  else if (key === 'agent') quoteToAgent(record)
}

const channels = ref<ChannelSummary[]>([])
const selected = ref<string>()
const records = ref<MessageRecord[]>([])
const list = ref<HTMLElement>()
const draft = ref('')
const sending = ref(false)

const bot = computed(() => data.bots.find((item) => item.id === props.botId))
const current = computed(() => channels.value.find((channel) => key(channel) === selected.value))

function key(channel: { type: string; id: string }) {
  return `${channel.type}:${channel.id}`
}

async function loadChannels() {
  // Only what the bot received or sent since Mushin started; older history is not shown here.
  channels.value = await call<ChannelSummary[]>('bots.channels', { id: props.botId, sinceStart: true })
  if (!selected.value && channels.value[0]) selected.value = key(channels.value[0])
}

async function loadMessages() {
  if (!current.value) {
    records.value = []
    return
  }
  const all = await call<MessageRecord[]>('bots.messages', { id: props.botId, channel: current.value.id, limit: 200, sinceStart: true })
  records.value = all.filter((record) => key(record.channel) === selected.value)
  scrollToEnd()
}

async function scrollToEnd() {
  await nextTick()
  list.value?.scrollTo({ top: list.value.scrollHeight })
}

onMounted(() => loadChannels().catch((error) => message.error(error.message)))
watch(() => props.botId, () => {
  selected.value = undefined
  loadChannels().catch(() => {})
})
watch(selected, () => loadMessages().catch(() => {}))

const off = on('bots/message', (record: MessageRecord) => {
  if (record.botId !== props.botId) return
  const k = key(record.channel)
  const existing = channels.value.find((channel) => key(channel) === k)
  const summary = { ...record.channel, name: record.channel.name ?? existing?.name, lastAt: record.timestamp, lastText: segmentsText(record.segments).slice(0, 80) }
  channels.value = [summary, ...channels.value.filter((channel) => key(channel) !== k)]
  if (!selected.value) selected.value = k
  if (k === selected.value) {
    records.value.push(record)
    scrollToEnd()
  }
})
onBeforeUnmount(off)

async function send() {
  if (!current.value || !draft.value.trim()) return
  sending.value = true
  try {
    await call('bots.send', { id: props.botId, channel: { type: current.value.type, id: current.value.id }, text: draft.value })
    draft.value = ''
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <Card class="live-card">
    <div class="live">
      <nav class="channels" :aria-label="t('live.channels')">
        <div v-if="!channels.length" class="channels-empty">{{ t('live.noChannels') }}</div>
        <button
          v-for="channel in channels"
          :key="key(channel)"
          type="button"
          class="channel"
          :class="{ active: key(channel) === selected }"
          @click="selected = key(channel)"
        >
          <span class="channel-icon text-[18px]" :class="channel.type === 'group' ? 'i-lucide-users' : 'i-lucide-user'" />
          <span class="channel-body">
            <span class="channel-name">{{ channel.name ?? channel.id }}</span>
            <span class="channel-last">{{ channel.lastText }}</span>
          </span>
          <span class="channel-time">{{ formatTime(channel.lastAt) }}</span>
        </button>
      </nav>

      <section class="conversation">
        <header v-if="current" class="conversation-head">
          <strong>{{ current.name ?? current.id }}</strong>
          <span class="mono sub">{{ current.type === 'group' ? t('live.group') : t('live.private') }} · {{ current.id }}</span>
          <span class="sub hover-hint">{{ t('live.hoverHint') }}</span>
        </header>
        <div ref="list" class="messages">
          <Empty v-if="!records.length" :description="t('live.empty')" class="messages-empty" />
          <div v-for="record in records" :key="record.id" class="message-row" :class="{ out: record.direction === 'out' }">
            <MessageBubble :record="record" />
            <Dropdown v-if="record.direction === 'in'" :options="actionOptions" @select="(key: string) => onAction(key, record)">
              <Button quaternary circle size="tiny" class="message-actions" :aria-label="t('live.actions')" icon="i-lucide-ellipsis" />
            </Dropdown>
          </div>
        </div>
        <footer v-if="current" class="composer">
          <Input
            v-model:value="draft"
            :placeholder="bot?.status === 'online' ? t('live.sendAs', { name: bot?.selfName ?? bot?.name }) : t('live.offline')"
            :disabled="bot?.status !== 'online'"
            @keyup.enter="send"
          />
          <Button type="primary" :loading="sending" :disabled="!draft.trim() || bot?.status !== 'online'" :aria-label="t('live.send')" icon="i-lucide-send" @click="send" />
        </footer>
      </section>
    </div>
  </Card>

  <Modal :show="!!runsFor" :title="t('live.runsTitle')" :width="520" @update:show="(show: boolean) => { if (!show) runsFor = undefined }">
    <template v-if="runsFor">
      <p class="muted quoted">{{ runsFor.user.name ?? runsFor.user.id }}：{{ segmentsText(runsFor.segments) }}</p>
      <Spin :show="loadingRuns">
        <p v-if="!runRows.length && !loadingRuns" class="muted small">{{ t('live.noRuns') }}</p>
        <ul class="run-list">
          <li v-for="row in runRows" :key="row.id">
            <button type="button" class="run-row" @click="openRun(row)">
              <strong>{{ row.flowName }}</strong>
              <Tag size="small" :type="row.status === 'ok' ? 'success' : row.status === 'error' ? 'error' : 'default'">{{ t(`runs.status.${row.status}`) }}</Tag>
              <span class="muted small">{{ formatTime(row.startedAt) }}</span>
              <span v-if="row.error" class="small run-error">{{ row.error }}</span>
            </button>
          </li>
        </ul>
      </Spin>
      <div class="run-actions">
        <Button size="small" @click="newFlow(runsFor!); runsFor = undefined">{{ t('live.actionNewFlow') }}</Button>
        <Button size="small" @click="quoteToAgent(runsFor!); runsFor = undefined">{{ t('live.actionAgent') }}</Button>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.live-card :deep(.mu-card__body) {
  padding: 0;
}

.message-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
}

.message-row.out {
  flex-direction: row-reverse;
}

.message-row > :first-child {
  min-width: 0;
}

.message-actions {
  margin-top: 22px;
  opacity: 0;
  transition: opacity 0.15s;
}

.message-row:hover .message-actions,
.message-actions:focus-visible {
  opacity: 1;
}

.quoted {
  margin: 0 0 10px;
  font-size: 13px;
}

.run-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}

.run-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.run-row:hover {
  background: var(--s2);
}

.run-error {
  color: var(--bad);
  width: 100%;
}

.run-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

@media (hover: none) {
  .message-actions {
    opacity: 1;
  }
}

.live {
  display: flex;
  height: min(70vh, 720px);
  min-height: 420px;
}

.channels {
  width: 260px;
  flex: none;
  border-right: 1px solid var(--line);
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.channels-empty {
  padding: 16px;
  font-size: 13px;
  opacity: 0.6;
}

.channel {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.channel:hover {
  background: var(--s2);
}

.channel.active {
  background: var(--primary-soft);
}

.channel-icon {
  opacity: 0.6;
  flex: none;
}

.channel-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.channel-name,
.channel-last {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-last,
.channel-time,
.sub {
  font-size: 12px;
  opacity: 0.55;
}

.channel-time {
  flex: none;
}

.conversation {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.conversation-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}

.hover-hint {
  margin-left: auto;
}

.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.messages-empty {
  margin: auto;
}

.composer {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
}

@media (max-width: 720px) {
  .live {
    flex-direction: column;
    height: auto;
  }

  .channels {
    width: auto;
    max-height: 180px;
    border-right: none;
    border-bottom: 1px solid var(--line);
  }

  .messages {
    height: 60vh;
  }
}
</style>
