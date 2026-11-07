<script setup lang="ts">
import { Avatar, Button, Card, Empty, Input, RadioGroup, useToast } from '@mushin/ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call, on } from '../api'
import { avatarColor, initial } from '../botAvatar'
import { useAgentStore } from '../stores/agent'
import { useDataStore } from '../stores/data'
import type { ChannelSummary, Contact, MessageRecord, Segment } from '../types'
import { formatTime, segmentsText } from '../utils'
import MessageBubble from './MessageBubble.vue'

const props = defineProps<{ botId: string }>()
const { t } = useI18n()
const message = useToast()
const data = useDataStore()
const router = useRouter()
const agent = useAgentStore()

/** The chat that only exists in Mushin, where the dashboard plays a test user; see `bots.sandbox`. */
const SANDBOX_ID = '@sandbox'
const SANDBOX_KEY = `private:${SANDBOX_ID}`

const bot = computed(() => data.bots.find((item) => item.id === props.botId))
const adapter = computed(() => data.adapters.find((item) => item.id === bot.value?.adapter.type))

function key(channel: { type: string; id: string }) {
  return `${channel.type}:${channel.id}`
}

/** A person's or group's picture from the adapter's address template; nothing for the sandbox. */
function avatarOf(kind: 'user' | 'group', id: string) {
  const template = adapter.value?.avatars?.[kind]
  if (!template || !id || id === SANDBOX_ID) return
  return template.replaceAll('{id}', encodeURIComponent(id))
}

// ---- what to do with a message: a new flow from it, or quote it to the Agent ----

const sampleQuery = (record: MessageRecord) => `${record.botId}:${record.channel.id}:${record.id}`

const mentionsSelf = (segment: Segment) => segment.type === 'at' && !!bot.value?.selfId && String(segment.data.qq) === bot.value.selfId

/**
 * A trigger guessed from the message: a command when it starts with one of the bot's prefixes, else
 * a keyword. An @ of the bot is not part of the text (flows never see it there); in a group it
 * becomes the trigger's "@ me" condition instead.
 */
function guessTrigger(record: MessageRecord) {
  const mentioned = record.segments.some(mentionsSelf)
  const text = segmentsText(record.segments.filter((segment) => !mentionsSelf(segment))).trim()
  const prefixes = bot.value?.commands?.prefixes?.filter(Boolean).length ? bot.value.commands!.prefixes! : ['/']
  const prefix = [...prefixes].sort((a, b) => b.length - a.length).find((item) => text.startsWith(item))
  const word = (prefix ? text.slice(prefix.length) : text).trim().split(/\s+/)[0] ?? ''
  if (prefix && word) return { text, node: { id: 'trigger', type: 'trigger.command', config: { name: word } } }
  const when = mentioned && record.channel.type === 'group' ? { when: 'mention' } : {}
  return { text, node: { id: 'trigger', type: 'trigger.keyword', config: { keywords: [word.slice(0, 20) || text.slice(0, 20)], mode: 'contains', ...when } } }
}

async function newFlow(record: MessageRecord) {
  const { text, node } = guessTrigger(record)
  try {
    const flow = await call<{ id: string }>('flows.create', {
      name: t('live.newFlowName', { text: text.slice(0, 12) }),
      bots: [props.botId],
      nodes: [
        { ...node, position: { x: 80, y: 120 } },
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
    label: `${senderName(record)}：${segmentsText(record.segments).slice(0, 40)}`,
  }
  agent.open = true
}

// ---- the channel list: the sandbox on top, then chats with messages, then the account's other friends and groups ----

interface Entry {
  key: string
  type: 'group' | 'private'
  id: string
  name?: string
  remark?: string
  members?: number
  lastAt?: number
  lastText?: string
  sandbox?: boolean
}

const channels = ref<ChannelSummary[]>([])
const contacts = ref<Contact[]>([])
const selected = ref<string>()
const records = ref<MessageRecord[]>([])
const list = ref<HTMLElement>()
const draft = ref('')
const sending = ref(false)
const search = ref('')
const filter = ref<'all' | 'private' | 'group'>('all')

const filterOptions = computed(() => [
  { value: 'all', label: t('live.filterAll') },
  { value: 'private', label: t('live.filterFriends') },
  { value: 'group', label: t('live.filterGroups') },
])

const sandboxEntry = computed<Entry>(() => {
  const seen = channels.value.find((channel) => key(channel) === SANDBOX_KEY)
  return { key: SANDBOX_KEY, type: 'private', id: SANDBOX_ID, name: t('live.sandbox'), lastAt: seen?.lastAt, lastText: seen?.lastText ?? t('live.sandboxLast'), sandbox: true }
})

const contactByKey = computed(() => new Map(contacts.value.map((contact) => [key(contact), contact])))

const entries = computed<Entry[]>(() => {
  const recent = channels.value
    .filter((channel) => key(channel) !== SANDBOX_KEY)
    .map((channel): Entry => {
      const contact = contactByKey.value.get(key(channel))
      return { ...contact, ...channel, key: key(channel), name: channel.name ?? contact?.name }
    })
  const seen = new Set(recent.map((entry) => entry.key))
  const rest = contacts.value.filter((contact) => !seen.has(key(contact))).map((contact): Entry => ({ ...contact, key: key(contact) }))
  return [...recent, ...rest]
})

const shown = computed(() => {
  const words = search.value.trim().toLowerCase()
  return entries.value.filter((entry) => {
    if (filter.value !== 'all' && entry.type !== filter.value) return false
    if (!words) return true
    return [entry.name, entry.remark, entry.id].some((value) => value?.toLowerCase().includes(words))
  })
})

const current = computed(() => (selected.value === SANDBOX_KEY ? sandboxEntry.value : entries.value.find((entry) => entry.key === selected.value)))

const label = (entry: Entry) => entry.remark ?? entry.name ?? entry.id
const entryAvatar = (entry: Entry) => avatarOf(entry.type === 'group' ? 'group' : 'user', entry.id)

function senderName(record: MessageRecord) {
  if (record.direction === 'in' && record.user.id === SANDBOX_ID) return t('live.sandboxUser')
  return record.user.name ?? record.user.id
}

function senderAvatar(record: MessageRecord) {
  if (record.direction === 'out') return bot.value?.selfAvatar
  return avatarOf('user', record.user.id)
}

async function loadChannels() {
  // Only what the bot received or sent since Mushin started; older history is not shown here.
  channels.value = await call<ChannelSummary[]>('bots.channels', { id: props.botId, sinceStart: true })
  const first = channels.value.find((channel) => key(channel) !== SANDBOX_KEY)
  if (!selected.value) selected.value = first ? key(first) : SANDBOX_KEY
}

async function loadContacts() {
  contacts.value = bot.value?.status === 'online' ? await call<Contact[]>('bots.contacts', { id: props.botId }).catch(() => []) : []
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

onMounted(() => {
  loadChannels().catch((error) => message.error(error.message))
  void loadContacts()
})
watch(() => props.botId, () => {
  selected.value = undefined
  contacts.value = []
  loadChannels().catch(() => {})
  void loadContacts()
})
watch(() => bot.value?.status, (status, previous) => {
  if (status === 'online' && previous !== 'online') void loadContacts()
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

const inSandbox = computed(() => current.value?.sandbox === true)
// The sandbox needs the bot running, not connected: its replies never reach the platform.
const canSend = computed(() => (inSandbox.value ? !!bot.value?.enabled : bot.value?.status === 'online'))
const placeholder = computed(() => {
  if (inSandbox.value) return t('live.sandboxSend')
  return bot.value?.status === 'online' ? t('live.sendAs', { name: bot.value?.selfName ?? bot.value?.name }) : t('live.offline')
})

async function send() {
  if (!current.value || !draft.value.trim() || !canSend.value) return
  sending.value = true
  try {
    if (inSandbox.value) await call('bots.sandbox', { id: props.botId, text: draft.value })
    else await call('bots.send', { id: props.botId, channel: { type: current.value.type, id: current.value.id }, text: draft.value })
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
        <div class="channel-tools">
          <Input v-model:value="search" size="small" clearable :placeholder="t('live.search')" />
          <RadioGroup v-model:value="filter" size="small" block :options="filterOptions" />
        </div>
        <div class="channel-list">
          <button
            type="button"
            class="channel pinned"
            :class="{ active: selected === SANDBOX_KEY }"
            @click="selected = SANDBOX_KEY"
          >
            <Avatar :size="36" square color="var(--primary)"><span class="i-lucide-flask-conical text-[18px]" /></Avatar>
            <span class="channel-body">
              <span class="channel-name">{{ sandboxEntry.name }}<span class="i-lucide-pin pin" /></span>
              <span class="channel-last">{{ sandboxEntry.lastText }}</span>
            </span>
          </button>
          <div v-if="!entries.length" class="channels-empty">{{ t('live.noChannels') }}</div>
          <div v-else-if="!shown.length" class="channels-empty">{{ t('live.noMatch') }}</div>
          <button
            v-for="entry in shown"
            :key="entry.key"
            type="button"
            class="channel"
            :class="{ active: entry.key === selected }"
            @click="selected = entry.key"
          >
            <Avatar :size="36" :src="entryAvatar(entry)" :color="avatarColor(entry.id)">
              <span v-if="entry.type === 'group'" class="i-lucide-users text-[16px]" />
              <template v-else>{{ initial(label(entry)) }}</template>
            </Avatar>
            <span class="channel-body">
              <span class="channel-name">{{ label(entry) }}</span>
              <span class="channel-last">
                <template v-if="entry.lastText !== undefined">{{ entry.lastText }}</template>
                <template v-else>{{ entry.type === 'group' ? t('live.group') : t('live.private') }} · {{ entry.id }}<template v-if="entry.members"> · {{ t('live.members', { n: entry.members }) }}</template></template>
              </span>
            </span>
            <span v-if="entry.lastAt" class="channel-time">{{ formatTime(entry.lastAt) }}</span>
          </button>
        </div>
      </nav>

      <section class="conversation">
        <header v-if="current" class="conversation-head">
          <strong>{{ label(current) }}</strong>
          <span v-if="current.sandbox" class="sub">{{ t('live.sandboxHint') }}</span>
          <template v-else>
            <span class="mono sub">{{ current.type === 'group' ? t('live.group') : t('live.private') }} · {{ current.id }}</span>
            <span class="sub hover-hint">{{ t('live.hoverHint') }}</span>
          </template>
        </header>
        <div ref="list" class="messages">
          <Empty v-if="!records.length" :description="t('live.empty')" class="messages-empty" />
          <MessageBubble
            v-for="record in records"
            :key="record.id"
            :record="record"
            :avatar="senderAvatar(record)"
            :name="senderName(record)"
            @new-flow="newFlow(record)"
            @quote="quoteToAgent(record)"
          />
        </div>
        <footer v-if="current" class="composer">
          <Input v-model:value="draft" :placeholder="placeholder" :disabled="!canSend" @keyup.enter="send" />
          <Button type="primary" :loading="sending" :disabled="!draft.trim() || !canSend" :aria-label="t('live.send')" icon="i-lucide-send" @click="send" />
        </footer>
      </section>
    </div>
  </Card>
</template>

<style scoped>
.live-card :deep(.mu-card__body) {
  padding: 0;
}

.live {
  display: flex;
  height: min(70vh, 720px);
  min-height: 420px;
}

.channels {
  width: clamp(200px, 34%, 280px);
  flex: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
}

.channel-tools {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}

.channel-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.channel.pinned {
  border-bottom: 1px solid var(--line);
}

.pin {
  margin-left: 4px;
  font-size: 12px;
  opacity: 0.45;
  vertical-align: -1px;
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
    max-height: 300px;
    border-right: none;
    border-bottom: 1px solid var(--line);
  }

  .messages {
    height: 60vh;
  }
}
</style>
