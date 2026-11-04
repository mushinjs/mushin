<script setup lang="ts">
/** A single-value slider. `formatTooltip` shows the value above the thumb while it is dragged or focused. */
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui'
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{
  value?: number
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  formatTooltip?: (value: number) => string
}>(), { value: 0, min: 0, max: 100, step: 1 })

const emit = defineEmits<{ 'update:value': [value: number] }>()
const model = computed(() => [props.value])
const active = ref(false)
const label = computed(() => (props.formatTooltip ? props.formatTooltip(props.value) : String(props.value)))
</script>

<template>
  <SliderRoot
    class="mu-slider"
    :class="{ 'is-disabled': disabled }"
    :model-value="model"
    :min="min"
    :max="max"
    :step="step"
    :disabled="disabled"
    @update:model-value="(next) => next && next[0] !== undefined && emit('update:value', next[0])"
    @pointerdown="active = true"
    @pointerup="active = false"
    @lostpointercapture="active = false"
  >
    <SliderTrack class="mu-slider__track">
      <SliderRange class="mu-slider__range" />
    </SliderTrack>
    <SliderThumb class="mu-slider__thumb" :aria-valuetext="label" @focus="active = true" @blur="active = false">
      <span v-if="active" class="mu-slider__tip">{{ label }}</span>
    </SliderThumb>
  </SliderRoot>
</template>

<style>
.mu-slider {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 30px;
  touch-action: none;
  user-select: none;
}

.mu-slider.is-disabled { opacity: 0.5; }

.mu-slider__track {
  position: relative;
  flex: 1;
  height: 4px;
  border-radius: 999px;
  background: var(--s3);
}

.mu-slider__range {
  position: absolute;
  height: 100%;
  border-radius: inherit;
  background: var(--primary);
}

.mu-slider__thumb {
  position: relative;
  display: block;
  width: 14px;
  height: 14px;
  box-sizing: border-box;
  border: 2px solid var(--primary);
  border-radius: 50%;
  background: var(--raised);
  cursor: grab;
  transition: box-shadow 0.15s;
}

.mu-slider__thumb:hover { box-shadow: 0 0 0 4px var(--primary-soft); }
.mu-slider__thumb:focus-visible { outline: none; box-shadow: 0 0 0 4px var(--focus); }
.mu-slider.is-disabled .mu-slider__thumb { cursor: not-allowed; }

.mu-slider__tip {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--fg);
  color: var(--bg);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}
</style>
