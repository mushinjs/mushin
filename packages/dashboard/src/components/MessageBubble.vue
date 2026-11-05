<script setup lang="ts">
import { Popover, Tag } from '@mushin/ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import type { MessageRecord } from '../types'
import { formatTime } from '../utils'
import MessageContent from './message/MessageContent.vue'

const props = defineProps<{ record: MessageRecord }>()
const { t, te } = useI18n()

const outgoing = computed(() => props.record.direction === 'out')
// Opens on hover and on keyboard focus, so the details are reachable without a mouse.
const open = ref(false)
const source = computed(() => props.record.source)

const sourceLabel = computed(() => t(`source.${source.value.kind}`))
const sourceDetail = computed(() => {
  const s = source.value
  switch (s.kind) {
    case 'llm':
      return [
        [t('hover.provider'), s.provider],
        [t('hover.model'), s.model],
        [t('hover.latency'), `${s.latencyMs} ms`],
        ...(s.tokens !== undefined ? [[t('hover.tokens'), String(s.tokens)]] : []),
        ...(s.persona ? [[t('hover.persona'), s.persona]] : []),
        ...(s.plugin ? [[t('hover.viaPlugin'), s.plugin]] : []),
      ]
    case 'plugin':
      return [[t('hover.plugin'), s.plugin]]
    case 'flow':
      return [
        [t('hover.flow'), s.flow],
        [t('hover.node'), s.node],
        ...(s.model ? [[t('hover.provider'), s.provider ?? ''], [t('hover.model'), s.model]] : []),
        ...(s.persona ? [[t('hover.persona'), s.persona]] : []),
      ]
    case 'agent':
      return [[t('hover.session'), s.session]]
    default:
      return []
  }
})

/** Knowledge base passages a flow reply was written from. */
const knowledge = computed(() => (source.value.kind === 'flow' ? source.value.knowledge ?? [] : []))

const typeLabel = computed(() => (te(`messageType.${props.record.type}`) ? t(`messageType.${props.record.type}`) : props.record.type))

/** A message that is only an image, video, card or forward shows without the bubble around it, as in QQ. */
const BLOCKS = new Set(['image', 'mface', 'video', 'forward', 'node', 'json', 'file'])
const bare = computed(() => {
  const shown = props.record.segments.filter((segment) => segment.type !== 'reply')
  if (!shown.length) return false
  if (shown.every((segment) => segment.type === 'node')) return true
  return shown.length === 1 && BLOCKS.has(shown[0].type)
})
</script>

<template>
  <div class="row" :class="{ out: outgoing }">
    <div class="meta">
      <span class="who">{{ record.user.name ?? record.user.id }}</span>
      <span class="time">{{ formatTime(record.timestamp) }}</span>
    </div>
    <Popover :show="open" :placement="outgoing ? 'left' : 'right'" align="start" keep-focus :style="{ maxWidth: '300px' }">
      <template #trigger>
        <div
          class="bubble"
          :class="[`source-${source.kind}`, { bare }]"
          tabindex="0"
          :data-message-id="record.id"
          @mouseenter="open = true"
          @mouseleave="open = false"
          @focus="open = true"
          @blur="open = false"
        >
          <MessageContent :segments="record.segments" :bot-id="record.botId" :channel="record.channel" />
        </div>
      </template>
      <dl class="info">
        <dt>{{ t('hover.type') }}</dt>
        <dd>{{ typeLabel }}</dd>
        <dt>{{ t('hover.platforms') }}</dt>
        <dd>
          <template v-if="record.platforms.length">
            <Tag v-for="platform in record.platforms" :key="platform" size="tiny">{{ platform }}</Tag>
          </template>
          <span v-else>{{ t('hover.noPlatform') }}</span>
        </dd>
        <dt>{{ t('hover.source') }}</dt>
        <dd>
          <Tag size="tiny" :type="source.kind === 'llm' ? 'info' : source.kind === 'plugin' ? 'success' : 'default'">
            {{ sourceLabel }}
          </Tag>
        </dd>
        <template v-for="[key, value] in sourceDetail" :key="key">
          <dt class="sub">{{ key }}</dt>
          <dd class="mono">{{ value }}</dd>
        </template>
        <template v-if="knowledge.length">
          <dt>{{ t('hover.knowledge') }}</dt>
          <dd class="sources">
            <RouterLink v-for="(item, index) in knowledge" :key="item.chunk" :to="`/knowledge/${item.base}/chunks?doc=${item.doc}&chunk=${item.chunk}`">[{{ index + 1 }}] {{ item.title }}</RouterLink>
          </dd>
        </template>
      </dl>
    </Popover>
  </div>
</template>

<style scoped>
.sources {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  max-width: 100%;
}

.row.out {
  align-items: flex-end;
}

.meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  opacity: 0.6;
}

.bubble {
  max-width: min(520px, 85%);
  padding: 8px 12px;
  border-radius: 12px;
  border-top-left-radius: 4px;
  background: var(--s3);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  cursor: default;
  outline: none;
  border: 1px solid transparent;
}

.out .bubble {
  border-top-left-radius: 12px;
  border-top-right-radius: 4px;
  background: var(--primary-soft);
}

.bubble:hover,
.bubble:focus-visible {
  border-color: var(--primary);
}

.bubble.bare,
.out .bubble.bare {
  padding: 0;
  background: transparent;
}

.out .bubble.source-llm {
  background: var(--info-soft);
}

.out .bubble.source-plugin {
  background: var(--ok-soft);
}

.info {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  margin: 0;
  font-size: 13px;
  align-items: center;
}

.info dt {
  opacity: 0.6;
}

.info dt.sub {
  padding-left: 10px;
}

.info dd {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
