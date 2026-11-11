<script setup lang="ts">
import { Image } from '@mushinjs/ui'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { loadableUrl, type MediaChannel, resolveMedia } from '../../media'
import type { Segment } from '../../types'

const props = defineProps<{ botId: string; segment: Segment; channel?: MediaChannel }>()
const { t } = useI18n()

const direct = computed(() => loadableUrl(props.segment.data.url) ?? loadableUrl(props.segment.data.file))
// The address in the message first; when QQ no longer serves it, the bytes fetched again through Mushin.
const src = ref<string>()
const state = ref<'loading' | 'shown' | 'failed'>('loading')
let retried = false

async function refetch() {
  if (retried) {
    state.value = 'failed'
    return
  }
  retried = true
  state.value = 'loading'
  try {
    src.value = (await resolveMedia(props.botId, props.segment, props.channel, true)).url
  } catch {
    state.value = 'failed'
  }
}

function reset() {
  retried = false
  state.value = 'loading'
  src.value = direct.value
  if (!src.value) void refetch()
}

onMounted(reset)
watch(() => props.segment, reset)
</script>

<template>
  <span class="media-image" :class="{ sticker: segment.type === 'mface' }">
    <!--
      QQ's image servers answer requests that carry another site's address as the referrer with an
      anti-hotlinking placeholder, so images are fetched without one.
    -->
    <Image
      v-if="src && state !== 'failed'"
      :src="src"
      referrerpolicy="no-referrer"
      alt=""
      :preview-disabled="segment.type === 'mface'"
      object-fit="contain"
      class="image"
      @load="state = 'shown'"
      @error="refetch"
    />
    <span v-if="state === 'loading' && !src" class="placeholder" />
    <a v-if="state === 'failed' && direct" :href="direct" target="_blank" rel="noreferrer noopener" class="missing">{{ t('segment.imageExpired') }}</a>
    <span v-else-if="state === 'failed'" class="missing">{{ t('segment.imageMissing') }}</span>
  </span>
</template>

<style scoped>
.media-image {
  display: block;
  margin: 2px 0;
}

.image {
  max-width: min(320px, 100%);
  max-height: 320px;
  border-radius: 8px;
}

.sticker .image {
  max-width: 140px;
  max-height: 140px;
}

.placeholder {
  display: block;
  width: 160px;
  height: 120px;
  border-radius: 8px;
  background: var(--s2);
}

.missing {
  display: inline-block;
  font-size: 12px;
  opacity: 0.75;
  color: inherit;
}
</style>
