<script setup lang="ts">
/**
 * Picks the editor's sample: a bot that is online, one of its recent chats, then a message
 * someone sent there. While one is picked the button shows who sent it.
 */
import { ChatbubblesOutline, CloseOutline, PeopleOutline, PersonOutline, RefreshOutline } from '@vicons/ionicons5'
import { NButton, NEmpty, NIcon, NPopover, NSelect, NSpin, NTag } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { call } from '../../../api'
import type { ChannelSummary, MessageRecord } from '../../../types'
import { formatTime, segmentsText } from '../../../utils'
import { useEditor } from './editor'

const { t, data, bots, sample, sampleMatch, matching, sampleError, clearSample } = useEditor()

const open = ref(false)
const bot = ref<string>()
const channel = ref<string>()
const channels = ref<ChannelSummary[]>([])
const messages = ref<MessageRecord[]>([])
const loading = ref(false)

/** Bots that can give samples: the flow's own first, online ones only. */
const botOptions = computed(() => {
  const online = data.bots.filter((item) => item.status === 'online')
  const ordered = [...online.filter((item) => bots.value.includes(item.id)), ...online.filter((item) => !bots.value.includes(item.id))]
  return ordered.map((item) => ({ value: item.id, label: bots.value.includes(item.id) ? item.name : `${item.name} · ${t('flows.sampleOtherBot')}` }))
})

watch(open, (value) => {
  if (!value) return
  bot.value = sample.value?.bot ?? (botOptions.value.some((item) => item.value === bot.value) ? bot.value : botOptions.value[0]?.value)
  void loadChannels()
})

async function loadChannels() {
  channels.value = []
  messages.value = []
  if (!bot.value) return
  loading.value = true
  try {
    channels.value = await call<ChannelSummary[]>('bots.channels', { id: bot.value })
    channel.value = sample.value?.bot === bot.value && channels.value.some((item) => item.id === sample.value!.channel)
      ? sample.value.channel
      : channels.value[0]?.id
    await loadMessages()
  } finally {
    loading.value = false
  }
}

async function loadMessages() {
  if (!bot.value || !channel.value) {
    messages.value = []
    return
  }
  const list = await call<MessageRecord[]>('bots.messages', { id: bot.value, channel: channel.value, limit: 60 })
  // Newest first, and only what people sent: those are the messages flows answer.
  messages.value = list.filter((record) => record.direction === 'in').reverse()
}

watch(bot, (value, previous) => {
  if (previous !== undefined && value !== previous) void loadChannels()
})
watch(channel, (value, previous) => {
  if (previous !== undefined && value !== previous) void loadMessages()
})

const channelOptions = computed(() => channels.value.map((item) => ({
  value: item.id,
  label: `${item.name || item.id}${item.type === 'private' ? ` · ${t('flows.samplePrivate')}` : ''}`,
})))

function pick(record: MessageRecord) {
  sample.value = { bot: record.botId, channel: record.channel.id, id: record.id }
  open.value = false
}

const label = computed(() => {
  const message = sampleMatch.value?.message
  if (!message) return sample.value ? t('flows.sampleLoading') : t('flows.sample')
  return `${message.user.name ?? message.user.id}：${message.text}`
})
const matched = computed(() => sampleMatch.value?.triggers.filter((item) => item.matched).length ?? 0)
</script>

<template>
  <NPopover v-model:show="open" trigger="click" placement="bottom-end" :show-arrow="false" class="sample-pop">
    <template #trigger>
      <NButton
        size="small"
        :secondary="!!sample"
        :quaternary="!sample"
        :type="sample ? (sampleError ? 'warning' : 'info') : 'default'"
        class="sample-button"
        :title="sample ? label : t('flows.sampleHint')"
        data-agent-target="flows.sample"
      >
        <template #icon><NIcon><ChatbubblesOutline /></NIcon></template>
        <span class="sample-label">{{ sample ? label : t('flows.sample') }}</span>
        <NTag v-if="sampleMatch" size="tiny" :bordered="false" round :type="matched ? 'success' : 'default'" class="count">
          {{ t('flows.sampleMatched', { n: matched }) }}
        </NTag>
      </NButton>
    </template>
    <div class="picker">
      <p class="muted small intro">{{ t('flows.sampleIntro') }}</p>
      <NEmpty v-if="!botOptions.length" size="small" :description="t('flows.sampleNoBot')" />
      <template v-else>
        <div class="selects">
          <NSelect v-model:value="bot" size="small" :options="botOptions" :aria-label="t('flows.sampleBot')" />
          <NSelect v-model:value="channel" size="small" :options="channelOptions" :placeholder="t('flows.sampleNoChat')" :aria-label="t('flows.sampleChat')" filterable />
          <NButton size="small" quaternary circle :aria-label="t('common.refresh')" @click="loadChannels"><template #icon><NIcon><RefreshOutline /></NIcon></template></NButton>
        </div>
        <NSpin :show="loading" size="small">
          <ul class="messages" role="listbox" :aria-label="t('flows.sampleMessages')">
            <li v-if="!messages.length && !loading" class="muted small empty">{{ t('flows.sampleNoMessages') }}</li>
            <li
              v-for="record in messages"
              :key="record.id"
              role="option"
              tabindex="0"
              :aria-selected="sample?.id === record.id"
              :class="{ on: sample?.id === record.id }"
              @click="pick(record)"
              @keydown.enter="pick(record)"
            >
              <NIcon :size="13" class="who-icon"><PeopleOutline v-if="record.channel.type === 'group'" /><PersonOutline v-else /></NIcon>
              <span class="who">{{ record.user.name ?? record.user.id }}</span>
              <span class="text">{{ segmentsText(record.segments) }}</span>
              <span class="time muted">{{ formatTime(record.timestamp) }}</span>
            </li>
          </ul>
        </NSpin>
      </template>
      <div v-if="sample" class="foot">
        <span v-if="sampleError" class="small warn">{{ sampleError }}</span>
        <span v-else-if="matching" class="muted small">{{ t('flows.sampleChecking') }}</span>
        <span class="spacer" />
        <NButton size="tiny" quaternary @click="clearSample(); open = false">
          <template #icon><NIcon><CloseOutline /></NIcon></template>
          {{ t('flows.sampleClear') }}
        </NButton>
      </div>
    </div>
  </NPopover>
</template>

<style scoped>
.sample-button {
  max-width: 260px;
}

.sample-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 170px;
}

.count {
  margin-left: 6px;
}

.picker {
  width: min(420px, calc(100vw - 32px));
}

.intro {
  margin: 0 0 8px;
  line-height: 1.5;
}

.selects {
  display: grid;
  grid-template-columns: 1fr 1.3fr auto;
  gap: 6px;
  margin-bottom: 8px;
}

.messages {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 300px;
  overflow: auto;
}

.messages li {
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.messages li:hover,
.messages li:focus-visible {
  background: rgba(127, 127, 127, 0.1);
  outline: none;
}

.messages li.on {
  background: color-mix(in srgb, var(--primary, #18a058) 14%, transparent);
}

.messages li.empty {
  display: block;
  cursor: default;
}

.who {
  font-weight: 500;
  white-space: nowrap;
}

.text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time {
  font-size: 11px;
  white-space: nowrap;
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.spacer {
  flex: 1;
}

.warn {
  color: var(--warning, #f0a020);
}
</style>
