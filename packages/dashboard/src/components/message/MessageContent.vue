<script setup lang="ts">
import { Button, useToast } from '@mushinjs/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { forwardedMessage, type ForwardedMessage, loadableUrl, type MediaChannel, resolveMedia, saveFile } from '../../media'
import type { Segment } from '../../types'
import { formatBytes } from '../../utils'
import ForwardCard from './ForwardCard.vue'
import MediaImage from './MediaImage.vue'
import VideoCard from './VideoCard.vue'

/** A message's segments as QQ shows them: text inline; images, videos, files, cards and forwards as blocks. */
const props = defineProps<{ segments: Segment[]; botId: string; channel?: MediaChannel }>()
const { t, te } = useI18n()
const message = useToast()

type Item =
  | { kind: 'segment'; segment: Segment }
  | { kind: 'forward'; id?: string; messages?: ForwardedMessage[] }

// A forward the bot sends is a run of `node` segments; a received one is a `forward` segment,
// which may already carry its messages in `content`.
const items = computed(() => {
  const result: Item[] = []
  for (const segment of props.segments) {
    if (segment.type === 'node') {
      const last = result.at(-1)
      const node = forwardedMessage(segment)
      if (last?.kind === 'forward' && last.messages && !last.id) last.messages.push(node)
      else result.push({ kind: 'forward', messages: [node] })
    } else if (segment.type === 'forward') {
      const content = segment.data.content
      result.push({
        kind: 'forward',
        id: segment.data.id !== undefined ? String(segment.data.id) : undefined,
        messages: Array.isArray(content) && content.length ? content.map(forwardedMessage) : undefined,
      })
    } else {
      result.push({ kind: 'segment', segment })
    }
  }
  return result
})

function label(type: string) {
  return te(`segment.${type}`) ? t(`segment.${type}`) : type
}

function inlineText(segment: Segment) {
  switch (segment.type) {
    case 'text':
      return segment.data.text
    case 'at':
      return `@${segment.data.name ?? segment.data.qq} `
    case 'reply':
      return ''
    default:
      return `[${label(segment.type)}]`
  }
}

/** What a QQ card (`json` segment) shows: title, description, picture, link. */
function card(segment: Segment) {
  let value: any
  try {
    value = typeof segment.data.data === 'string' ? JSON.parse(segment.data.data) : segment.data.data
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const meta = value.meta ?? {}
  // A forwarded history sent as a card.
  if (value.app === 'com.tencent.multimsg' && meta.detail) {
    return {
      title: meta.detail.source || value.prompt,
      lines: (meta.detail.news ?? []).map((item: any) => String(item?.text ?? '')),
      foot: meta.detail.summary,
    }
  }
  const inner = meta.detail_1 ?? meta.news ?? meta.music ?? meta.contact ?? Object.values(meta)[0] ?? {}
  return {
    title: inner.title || value.prompt,
    desc: inner.desc,
    preview: loadableUrl(inner.preview) ?? loadableUrl(inner.icon),
    url: loadableUrl(inner.qqdocurl) ?? loadableUrl(inner.jumpUrl) ?? loadableUrl(inner.url),
    foot: inner.tag || inner.source,
  }
}

async function download(segment: Segment) {
  try {
    const media = await resolveMedia(props.botId, segment, props.channel).catch(() => undefined)
    const url = media?.url ?? loadableUrl(segment.data.url)
    if (!url) throw new Error(t('segment.noAddress'))
    saveFile(url, media?.name ?? segment.data.name ?? segment.data.file)
  } catch (error) {
    message.error(t('segment.downloadFailed', { error: (error as Error).message }))
  }
}
</script>

<template>
  <template v-for="(item, index) in items" :key="index">
    <ForwardCard v-if="item.kind === 'forward'" :bot-id="botId" :channel="channel" :forward-id="item.id" :messages="item.messages" />
    <template v-else>
      <MediaImage v-if="item.segment.type === 'image' || item.segment.type === 'mface'" :bot-id="botId" :segment="item.segment" :channel="channel" />
      <VideoCard v-else-if="item.segment.type === 'video'" :bot-id="botId" :segment="item.segment" :channel="channel" />
      <span v-else-if="item.segment.type === 'file' || item.segment.type === 'record'" class="file">
        <span class="file-icon text-[28px]" :class="item.segment.type === 'record' ? 'i-lucide-mic' : 'i-lucide-file'" />
        <span class="file-body">
          <span class="file-name">{{ item.segment.type === 'record' ? label('record') : item.segment.data.name ?? item.segment.data.file ?? label('file') }}</span>
          <span v-if="Number(item.segment.data.file_size)" class="file-size">{{ formatBytes(Number(item.segment.data.file_size)) }}</span>
        </span>
        <Button circle size="small" quaternary :aria-label="t('segment.download')" :title="t('segment.download')" icon="i-lucide-download" @click="download(item.segment)" />
      </span>
      <template v-else-if="item.segment.type === 'json' && card(item.segment)">
        <component
          :is="card(item.segment)!.url ? 'a' : 'span'"
          class="card"
          :href="card(item.segment)!.url"
          target="_blank"
          rel="noreferrer noopener"
        >
          <strong class="card-title">{{ card(item.segment)!.title }}</strong>
          <span v-if="card(item.segment)!.desc" class="card-desc">{{ card(item.segment)!.desc }}</span>
          <span v-for="(line, lineIndex) in card(item.segment)!.lines ?? []" :key="lineIndex" class="card-line">{{ line }}</span>
          <img v-if="card(item.segment)!.preview" :src="card(item.segment)!.preview" class="card-preview" alt="" referrerpolicy="no-referrer">
          <span v-if="card(item.segment)!.foot" class="card-foot">{{ card(item.segment)!.foot }}</span>
        </component>
      </template>
      <span v-else-if="item.segment.type === 'at'" class="at">{{ inlineText(item.segment) }}</span>
      <span v-else>{{ inlineText(item.segment) }}</span>
    </template>
  </template>
</template>

<style scoped>
.at {
  color: var(--primary);
}

.file {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(280px, 100%);
  margin: 2px 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--s2);
  white-space: normal;
}

.file-icon {
  flex: none;
  opacity: 0.7;
}

.file-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  font-size: 12px;
  opacity: 0.6;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: min(300px, 100%);
  margin: 2px 0;
  padding: 10px 12px 8px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--s2);
  color: inherit;
  white-space: normal;
  text-decoration: none;
}

a.card:hover {
  background: var(--s3);
  text-decoration: none;
}

.card-title {
  font-weight: 600;
}

.card-desc,
.card-line {
  font-size: 13px;
  opacity: 0.7;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.card-line {
  -webkit-line-clamp: 1;
}

.card-preview {
  display: block;
  max-width: 100%;
  max-height: 180px;
  margin-top: 6px;
  border-radius: 6px;
  object-fit: cover;
}

.card-foot {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  opacity: 0.6;
}
</style>
