<script setup lang="ts">
import { Popover, Slider, Tooltip } from '@mushinjs/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { modelCapabilities } from '../../models'
import { EFFORTS, useConversation } from '../../stores/fairy'
import { useFairyDefaults } from './fairyDefaults'

/**
 * How hard the model thinks, for the next messages: a slider that stops at each level (drag it, use the
 * arrow keys, or click a level). Off, with a hint why, when the model in use does not reason.
 */
const { t } = useI18n()
const fairy = useConversation()
const defaults = useFairyDefaults()

/** The model in use; the name is all there is to go by, so an unknown model counts as one that reasons. */
const model = computed(() => fairy.choice.model ?? (fairy.choice.provider ? undefined : defaults.model.value))
const supported = computed(() => !model.value || modelCapabilities(model.value).includes('reasoning'))

const levels = computed(() => ['default', ...EFFORTS].map((key) => t(`fairyPicker.efforts.${key}`)))
/** 0 is the default effort, then one step per level. */
const step = computed(() => (fairy.choice.effort ? EFFORTS.indexOf(fairy.choice.effort) + 1 : 0))

function setStep(value: number) {
  fairy.choice = { ...fairy.choice, effort: value ? EFFORTS[value - 1] : undefined }
}
</script>

<template>
  <Tooltip v-if="!supported">
    <template #trigger>
      <button type="button" class="effort-chip off" aria-disabled="true">
        <span class="i-lucide-gauge" />
        <span>{{ t('fairyPicker.effortShort') }}</span>
      </button>
    </template>
    {{ t('fairyPicker.noEffort', { model }) }}
  </Tooltip>
  <Popover v-else placement="top" align="start" :width="280">
    <template #trigger>
      <button type="button" class="effort-chip" :class="{ set: step > 0 }" :title="t('fairyPicker.effort')">
        <span class="i-lucide-gauge" />
        <span>{{ step ? levels[step] : t('fairyPicker.effortShort') }}</span>
        <span class="i-lucide-chevron-down effort-caret" />
      </button>
    </template>
    <div class="effort">
      <div class="effort-head">
        <span class="effort-title">{{ t('fairyPicker.effort') }}</span>
        <span class="effort-value">{{ levels[step] }}</span>
      </div>
      <div class="effort-slider">
        <Slider :value="step" :min="0" :max="EFFORTS.length" :step="1" :format-tooltip="(value) => levels[value]" @update:value="setStep" />
      </div>
      <div class="effort-levels">
        <button
          v-for="(name, index) in levels"
          :key="index"
          type="button"
          class="effort-level"
          :class="{ current: index === step }"
          :style="{ left: `${(index / EFFORTS.length) * 100}%` }"
          @click="setStep(index)"
        >
          {{ name }}
        </button>
      </div>
      <p class="effort-hint">{{ t('fairyPicker.effortHint') }}</p>
    </div>
  </Popover>
</template>

<style scoped>
.effort-chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg3);
  font-size: 12px;
  cursor: pointer;
}

.effort-chip:hover,
.effort-chip[data-state='open'] {
  background: var(--s2);
  color: var(--fg);
}

.effort-chip.set {
  color: var(--primary);
}

.effort-chip.off {
  opacity: 0.5;
  cursor: not-allowed;
}

.effort-chip.off:hover {
  background: transparent;
  color: var(--fg3);
}

.effort-caret {
  font-size: 12px;
}

.effort {
  display: flex;
  flex-direction: column;
  font-size: 13px;
}

.effort-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.effort-title {
  color: var(--fg2);
}

.effort-value {
  font-weight: 500;
}

.effort-slider {
  margin-top: 4px;
}

/* The level names sit under the slider's stops; the thumb is 14px, so the stops run from 7px to 7px short. */
.effort-levels {
  position: relative;
  height: 20px;
  margin: 0 7px;
}

.effort-level {
  position: absolute;
  top: 0;
  padding: 1px 3px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--fg3);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  transform: translateX(-50%);
  cursor: pointer;
}

.effort-level:hover {
  color: var(--fg);
}

.effort-level.current {
  color: var(--primary);
  font-weight: 500;
}

.effort-hint {
  margin: 8px 0 0;
  color: var(--fg3);
  font-size: 11px;
}
</style>
