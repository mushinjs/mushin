<script setup lang="ts">
import { PeopleOutline, PersonOutline, SendOutline } from '@vicons/ionicons5'
import { NButton, NCard, NEmpty, NIcon, NInput, useMessage } from 'naive-ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call, on } from '../api'
import { useDataStore } from '../stores/data'
import type { ChannelSummary, MessageRecord } from '../types'
import { formatTime, segmentsText } from '../utils'
import MessageBubble from './MessageBubble.vue'

const props = defineProps<{ botId: string }>()
const { t } = useI18n()
const message = useMessage()
const data = useDataStore()

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
  channels.value = await call<ChannelSummary[]>('bots.channels', { id: props.botId })
  if (!selected.value && channels.value[0]) selected.value = key(channels.value[0])
}

async function loadMessages() {
  if (!current.value) {
    records.value = []
    return
  }
  const all = await call<MessageRecord[]>('bots.messages', { id: props.botId, channel: current.value.id, limit: 200 })
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
  <NCard content-style="padding: 0">
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
          <NIcon size="18" class="channel-icon">
            <PeopleOutline v-if="channel.type === 'group'" />
            <PersonOutline v-else />
          </NIcon>
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
          <NEmpty v-if="!records.length" :description="t('live.empty')" class="messages-empty" />
          <MessageBubble v-for="record in records" :key="record.id" :record="record" />
        </div>
        <footer v-if="current" class="composer">
          <NInput
            v-model:value="draft"
            :placeholder="bot?.status === 'online' ? t('live.sendAs', { name: bot?.selfName ?? bot?.name }) : t('live.offline')"
            :disabled="bot?.status !== 'online'"
            @keyup.enter="send"
          />
          <NButton type="primary" :loading="sending" :disabled="!draft.trim() || bot?.status !== 'online'" :aria-label="t('live.send')" @click="send">
            <template #icon><NIcon><SendOutline /></NIcon></template>
          </NButton>
        </footer>
      </section>
    </div>
  </NCard>
</template>

<style scoped>
.live {
  display: flex;
  height: min(70vh, 720px);
  min-height: 420px;
}

.channels {
  width: 260px;
  flex: none;
  border-right: 1px solid rgba(127, 127, 127, 0.18);
  overflow-y: auto;
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
  background: rgba(127, 127, 127, 0.08);
}

.channel.active {
  background: rgba(59, 74, 140, 0.12);
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
  border-bottom: 1px solid rgba(127, 127, 127, 0.18);
}

.hover-hint {
  margin-left: auto;
}

.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
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
  border-top: 1px solid rgba(127, 127, 127, 0.18);
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
    border-bottom: 1px solid rgba(127, 127, 127, 0.18);
  }

  .messages {
    height: 60vh;
  }
}
</style>
