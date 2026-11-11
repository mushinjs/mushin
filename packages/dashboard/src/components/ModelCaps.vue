<script setup lang="ts">
import { Tooltip } from '@mushinjs/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CAPABILITY_ICONS, modelCapabilities } from '../models'

/** Small icons for what a model can do (images, thinking, tools…), guessed from its name. */
const props = defineProps<{ model: string }>()
const { t } = useI18n()
const caps = computed(() => modelCapabilities(props.model))
</script>

<template>
  <span v-if="caps.length" class="model-caps">
    <Tooltip v-for="cap in caps" :key="cap" :delay="300">
      <template #trigger>
        <span :class="['model-cap', `model-cap-${cap}`]" :aria-label="t(`profiles.caps.${cap}`)">
          <span :class="CAPABILITY_ICONS[cap]" />
        </span>
      </template>
      {{ t(`profiles.caps.${cap}`) }}
    </Tooltip>
  </span>
</template>

<style scoped>
.model-caps {
  display: inline-flex;
  gap: 3px;
  margin-left: 6px;
  vertical-align: middle;
}

.model-cap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  font-size: 12px;
}

.model-cap-vision { color: #2080f0; background: rgba(32, 128, 240, 0.12); }
.model-cap-reasoning { color: #d48806; background: rgba(240, 160, 32, 0.14); }
.model-cap-tools { color: #18a058; background: rgba(24, 160, 88, 0.12); }
.model-cap-code { color: #7c5cd6; background: rgba(124, 92, 214, 0.12); }
.model-cap-embedding { color: #0e9aa7; background: rgba(14, 154, 167, 0.12); }
.model-cap-rerank { color: #0e9aa7; background: rgba(14, 154, 167, 0.12); }
.model-cap-image { color: #d03050; background: rgba(208, 48, 80, 0.12); }
.model-cap-audio { color: #c2410c; background: rgba(194, 65, 12, 0.12); }
</style>
