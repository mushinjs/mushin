<script setup lang="ts">
import { NPopover, NTag } from 'naive-ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MessageRecord, Segment } from '../types'
import { formatTime } from '../utils'

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

const typeLabel = computed(() => (te(`messageType.${props.record.type}`) ? t(`messageType.${props.record.type}`) : props.record.type))

function segmentText(segment: Segment) {
  switch (segment.type) {
    case 'text':
      return segment.data.text
    case 'at':
      return `@${segment.data.name ?? segment.data.qq} `
    case 'face':
      return `[${t('segment.face')}]`
    case 'reply':
      return ''
    default:
      return `[${te(`segment.${segment.type}`) ? t(`segment.${segment.type}`) : segment.type}]`
  }
}

/** Images and sticker images (`mface`) that can be shown, by their address. */
function imageUrl(segment: Segment) {
  if (segment.type !== 'image' && segment.type !== 'mface') return undefined
  const url = segment.data.url ?? segment.data.file
  return typeof url === 'string' && /^(https?:|data:image\/)/.test(url) ? url : undefined
}

// Images that failed to load: QQ's links expire after a while, and then only a note is shown.
const broken = ref(new Set<number>())
function onImageError(index: number) {
  broken.value = new Set([...broken.value, index])
}
</script>

<template>
  <div class="row" :class="{ out: outgoing }">
    <div class="meta">
      <span class="who">{{ record.user.name ?? record.user.id }}</span>
      <span class="time">{{ formatTime(record.timestamp) }}</span>
    </div>
    <NPopover trigger="manual" :show="open" :placement="outgoing ? 'left-start' : 'right-start'" :style="{ maxWidth: '300px' }">
      <template #trigger>
        <div
          class="bubble"
          :class="[`source-${source.kind}`]"
          tabindex="0"
          :data-message-id="record.id"
          @mouseenter="open = true"
          @mouseleave="open = false"
          @focus="open = true"
          @blur="open = false"
        >
          <template v-for="(segment, index) in record.segments" :key="index">
            <!--
              QQ's image servers answer requests that carry another site's address as the referrer with an
              anti-hotlinking placeholder, so images are fetched without one. Not lazy: a lazy image has no
              size until it loads, and in the conversation's scroll area it was never asked to load.
            -->
            <template v-if="imageUrl(segment)">
              <img
                v-if="!broken.has(index)"
                :src="imageUrl(segment)"
                class="image"
                alt=""
                decoding="async"
                referrerpolicy="no-referrer"
                @error="onImageError(index)"
              >
              <a v-else :href="imageUrl(segment)" target="_blank" rel="noreferrer noopener" class="image-missing">{{ t('segment.imageExpired') }}</a>
            </template>
            <span v-else-if="segment.type === 'at'" class="at">{{ segmentText(segment) }}</span>
            <span v-else>{{ segmentText(segment) }}</span>
          </template>
        </div>
      </template>
      <dl class="info">
        <dt>{{ t('hover.type') }}</dt>
        <dd>{{ typeLabel }}</dd>
        <dt>{{ t('hover.platforms') }}</dt>
        <dd>
          <template v-if="record.platforms.length">
            <NTag v-for="platform in record.platforms" :key="platform" size="tiny" :bordered="false">{{ platform }}</NTag>
          </template>
          <span v-else>{{ t('hover.noPlatform') }}</span>
        </dd>
        <dt>{{ t('hover.source') }}</dt>
        <dd>
          <NTag size="tiny" :type="source.kind === 'llm' ? 'info' : source.kind === 'plugin' ? 'success' : 'default'" :bordered="false">
            {{ sourceLabel }}
          </NTag>
        </dd>
        <template v-for="[key, value] in sourceDetail" :key="key">
          <dt class="sub">{{ key }}</dt>
          <dd class="mono">{{ value }}</dd>
        </template>
      </dl>
    </NPopover>
  </div>
</template>

<style scoped>
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
  background: rgba(127, 127, 127, 0.12);
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
  background: rgba(59, 74, 140, 0.14);
}

.bubble:hover,
.bubble:focus-visible {
  border-color: rgba(124, 139, 217, 0.6);
}

.out .bubble.source-llm {
  background: rgba(32, 128, 240, 0.14);
}

.out .bubble.source-plugin {
  background: rgba(24, 160, 88, 0.14);
}

.at {
  color: #2080f0;
}

.image {
  display: block;
  max-width: 220px;
  max-height: 220px;
  border-radius: 6px;
  margin: 4px 0;
}

.image-missing {
  display: inline-block;
  margin: 4px 0;
  font-size: 12px;
  opacity: 0.75;
  color: inherit;
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
