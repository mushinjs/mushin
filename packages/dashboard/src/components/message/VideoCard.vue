<script setup lang="ts">
import { DownloadOutline, Play } from '@vicons/ionicons5'
import { NButton, NIcon, useMessage } from 'naive-ui'
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { loadableUrl, type MediaChannel, resolveMedia, saveFile } from '../../media'
import type { Segment } from '../../types'
import { formatBytes } from '../../utils'

const props = defineProps<{ botId: string; segment: Segment; channel?: MediaChannel }>()
const { t } = useI18n()
const message = useMessage()

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
      <NIcon :size="26"><Play /></NIcon>
    </button>
    <div class="bar">
      <span v-if="size" class="size">{{ formatBytes(size) }}</span>
      <NButton circle size="small" secondary :loading="downloading" :aria-label="t('segment.download')" :title="t('segment.download')" @click.stop="download">
        <template #icon><NIcon><DownloadOutline /></NIcon></template>
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.video-card {
  position: relative;
  display: block;
  width: min(320px, 100%);
  margin: 2px 0;
  border-radius: 8px;
  overflow: hidden;
  background: #000;
}

.video {
  display: block;
  width: 100%;
  max-height: 360px;
  background: #000;
}

.blank {
  aspect-ratio: 16 / 9;
  background: linear-gradient(135deg, rgba(60, 64, 90, 0.9), rgba(20, 22, 32, 0.95));
}

.play {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  border: 2px solid rgba(255, 255, 255, 0.85);
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  cursor: pointer;
}

.play:hover {
  background: rgba(0, 0, 0, 0.6);
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
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 12px;
}
</style>
