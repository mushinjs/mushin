<script setup lang="ts">
import { Button, Tooltip } from '@mushinjs/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { updates } from '../../updates'

/** At the top of the Plugins page when there is a newer Mushin.js or plugin: what, its notes, and one button. */
const emit = defineEmits<{ update: [] }>()
const { t } = useI18n()

const info = computed(() => (updates.info?.mode === 'app' ? updates.info : undefined))
const mushin = computed(() => (info.value?.mushin?.available ? info.value.mushin : undefined))
const pluginCount = computed(() => info.value?.plugins.filter((plugin) => plugin.available && plugin.compatible).length ?? 0)
const shown = computed(() => !!mushin.value || pluginCount.value > 0)
</script>

<template>
  <div v-if="shown && info" class="banner" role="status">
    <span class="i-lucide-circle-arrow-up icon" />
    <div class="text">
      <Tooltip v-if="mushin" :max-width="440" placement="bottom">
        <template #trigger><strong class="title">{{ t('updates.banner', { version: mushin.available }) }}</strong></template>
        <div class="notes">{{ mushin.notes || t('updates.notesHint') }}</div>
      </Tooltip>
      <span v-if="pluginCount" class="sub">{{ t('updates.bannerPlugins', pluginCount) }}</span>
      <template v-if="mushin">
        <span class="sep">·</span>
        <a :href="mushin.notesUrl" target="_blank" rel="noopener" class="link">{{ t('updates.notes') }}</a>
      </template>
    </div>
    <Tooltip :disabled="info.supervised" :max-width="320">
      <template #trigger>
        <span><Button type="primary" size="small" icon="i-lucide-refresh-cw" :disabled="!info.supervised" @click="emit('update')">{{ t('updates.apply') }}</Button></span>
      </template>
      {{ t('updates.needsSupervisor') }}
    </Tooltip>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
  padding: 10px 12px 10px 14px;
  border: 1px solid color-mix(in srgb, var(--primary) 35%, transparent);
  border-radius: var(--radius);
  background: var(--primary-soft);
}

.icon {
  flex: none;
  color: var(--primary);
  font-size: 18px;
}

.text {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
}

.title {
  font-weight: 600;
  cursor: help;
}

.sub,
.sep {
  color: var(--fg2);
}

.link {
  color: var(--primary);
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}

.notes {
  max-height: 320px;
  overflow: hidden;
  white-space: pre-wrap;
  font-size: 12px;
}
</style>
