<script setup lang="ts">
import { Button, useToast } from '@mushin/ui'
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { loadableUrl, type MediaChannel, resolveMedia, saveFile } from '../../media'
import type { Segment } from '../../types'
import { formatBytes } from '../../utils'

const props = defineProps<{ botId: string; segment: Segment; channel?: MediaChannel }>()
const { t } = useI18n()
const message = useToast()

const src = ref(loadableUrl(props.segment.data.url))
const playing = ref(false)
const coverFailed = ref(false)
const downloading = ref(false)
const video = ref<HTMLVideoElement>()
const size = computed(() => Number(props.segment.data.file_size) || undefined)
let refreshed = false

/** The address in the message expires after a few hours; ask the platform for a current one. */
async function refresh() {
  refreshed = true
  const media = await resolveMedia(props.botId, props.segment, props.channel)
  src.value = media.url
  return media
}

// Only the first frame is loaded (`preload="metadata"`) for the cover; the video loads when played.
async function onError() {
  if (refreshed) {
    coverFailed.value = true
    return
  }
  try {
    await refresh()
  } catch {
    coverFailed.value = true
  }
}

async function play() {
  try {
    if (!src.value || coverFailed.value) await refresh()
    coverFailed.value = false
    playing.value = true
    await nextTick()
    await video.value?.play()
  } catch (error) {
    message.error(t('segment.videoFailed', { error: (error as Error).message }))
  }
}

async function download() {
  downloading.value = true
  try {
    const media = await resolveMedia(props.botId, props.segment, props.channel).catch(() => undefined)
    const url = media?.url ?? src.value
    if (!url) throw new Error(t('segment.noAddress'))
    saveFile(url, media?.name ?? props.segment.data.file)
  } catch (error) {
    message.error(t('segment.downloadFailed', { error: (error as Error).message }))
  } finally {
    downloading.value = false
  }
}
</script>

<template>
  <div class="video-card">
    <video
      v-if="src && !coverFailed"
      ref="video"
      :src="playing ? src : `${src}#t=0.1`"
      :preload="playing ? 'auto' : 'metadata'"
      :controls="playing"
      playsinline
      class="video"
      @error="onError"
    />
    <div v-else class="video blank" />
    <button v-if="!playing" type="button" class="play" :aria-label="t('segment.play')" @click="play">
      <span class="i-ph-play-fill text-[26px]" />
    </button>
    <div class="bar">
      <span v-if="size" class="size">{{ formatBytes(size) }}</span>
      <Button circle size="small" secondary :loading="downloading" :aria-label="t('segment.download')" :title="t('segment.download')" icon="i-lucide-download" @click.stop="download" />
    </div>
  </div>
</template>

<style scoped>
/* Video stays dark in both themes, like any player; its colors are named once here. */
.video-card {
  --video-bg: #000;
  --video-fg: #fff;
  --video-ring: rgba(255, 255, 255, 0.85);
  --video-scrim: rgba(0, 0, 0, 0.45);
  --video-scrim-strong: rgba(0, 0, 0, 0.6);
  --video-blank: linear-gradient(135deg, #3c405a, #141620);
  position: relative;
  display: block;
  width: min(320px, 100%);
  margin: 2px 0;
  border-radius: 8px;
  overflow: hidden;
  background: var(--video-bg);
}

.video {
  display: block;
  width: 100%;
  max-height: 360px;
  background: var(--video-bg);
}

.blank {
  aspect-ratio: 16 / 9;
  background: var(--video-blank);
}

.play {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  border: 2px solid var(--video-ring);
  border-radius: 50%;
  background: var(--video-scrim);
  color: var(--video-fg);
  cursor: pointer;
}

.play:hover {
  background: var(--video-scrim-strong);
}

.play:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.bar {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.size {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--video-scrim);
  color: var(--video-fg);
  font-size: 12px;
}
</style>
