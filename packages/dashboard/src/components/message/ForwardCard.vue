<script setup lang="ts">
import { Modal, Spin } from '@mushinjs/ui'
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { type ForwardedMessage, loadForward, type MediaChannel } from '../../media'
import type { Segment } from '../../types'
import { formatTime } from '../../utils'

// The history's messages can hold forwards of their own, rendered by the same component.
const MessageContent = defineAsyncComponent(() => import('./MessageContent.vue'))

/** Either the forward's id, read from the platform, or messages the segment already carries. */
const props = defineProps<{ botId: string; channel?: MediaChannel; forwardId?: string; messages?: ForwardedMessage[] }>()
const { t, te } = useI18n()

const list = ref<ForwardedMessage[] | undefined>(props.messages)
const loading = ref(false)
const error = ref<string>()
const open = ref(false)

async function load() {
  if (list.value || !props.forwardId) return
  loading.value = true
  error.value = undefined
  try {
    list.value = await loadForward(props.botId, props.forwardId)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
}

onMounted(load)

const names = computed(() => [...new Set((list.value ?? []).map((item) => item.user.name ?? item.user.id).filter(Boolean))])
const title = computed(() => {
  if (props.channel?.type === 'private' && names.value.length === 2) return t('forward.titleTwo', { a: names.value[0], b: names.value[1] })
  if (props.channel?.type === 'private' && names.value.length === 1) return t('forward.titleOne', { name: names.value[0] })
  return t('forward.titleGroup')
})

function summary(segments: Segment[]) {
  return segments.map((segment) => {
    if (segment.type === 'text') return segment.data.text ?? ''
    if (segment.type === 'at') return `@${segment.data.name ?? segment.data.qq} `
    if (segment.type === 'reply') return ''
    return `[${te(`segment.${segment.type}`) ? t(`segment.${segment.type}`) : segment.type}]`
  }).join('').replace(/\s+/g, ' ').trim()
}

const preview = computed(() => (list.value ?? []).slice(0, 4).map((item) => `${item.user.name ?? item.user.id}: ${summary(item.segments)}`))

function show() {
  if (error.value) void load()
  else open.value = true
}
</script>

<template>
  <button type="button" class="forward" @click="show">
    <strong class="title">{{ title }}</strong>
    <span v-if="loading" class="line muted">{{ t('forward.loading') }}</span>
    <span v-else-if="error" class="line error">{{ t('forward.failed', { error }) }}</span>
    <template v-else>
      <span v-for="(line, index) in preview" :key="index" class="line">{{ line }}</span>
    </template>
    <span class="foot">{{ list ? t('forward.view', { count: list.length }) : t('forward.viewAny') }}</span>
  </button>

  <Modal v-model:show="open" :title="title" :width="560">
    <Spin :show="loading">
      <ol class="history">
        <li v-for="(item, index) in list ?? []" :key="index" class="entry">
          <div class="meta">
            <span class="who">{{ item.user.name ?? item.user.id }}</span>
            <span v-if="item.timestamp" class="time">{{ formatTime(item.timestamp) }}</span>
          </div>
          <div class="body">
            <MessageContent :segments="item.segments" :bot-id="botId" :channel="channel" />
          </div>
        </li>
      </ol>
    </Spin>
  </Modal>
</template>

<style scoped>
.forward {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: min(300px, 100%);
  padding: 10px 12px 8px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--s2);
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: normal;
  cursor: pointer;
}

.forward:hover {
  background: var(--s3);
}

.forward:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.title {
  margin-bottom: 4px;
  font-weight: 600;
}

.line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  opacity: 0.7;
}

.line.error {
  color: var(--bad);
  opacity: 1;
  white-space: normal;
}

.foot {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  opacity: 0.6;
}

.history {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: min(65vh, 640px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  opacity: 0.6;
  margin-bottom: 4px;
}

.body {
  display: inline-block;
  max-width: 100%;
  padding: 8px 12px;
  border-radius: 4px 12px 12px 12px;
  background: var(--s2);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
