<script setup lang="ts">
/**
 * A loading spinner. With slot content it lays the spinner over that content while `show` is on;
 * alone it is just the spinner.
 */
import { useText } from '../config'

withDefaults(defineProps<{
  show?: boolean
  size?: 'small' | 'medium' | 'large' | number
  description?: string
}>(), { show: true, size: 'medium' })

const text = useText()
const px = (size: 'small' | 'medium' | 'large' | number) => (typeof size === 'number' ? size : { small: 16, medium: 22, large: 32 }[size])
</script>

<template>
  <div v-if="$slots.default" class="mu-spin-box" :aria-busy="show">
    <div :class="{ 'mu-spin-box__content--busy': show }"><slot /></div>
    <div v-if="show" class="mu-spin-box__mask">
      <span class="i-lucide-loader-circle mu-spin mu-spin-icon" :style="{ fontSize: `${px(size)}px` }" :aria-label="text.loading" />
      <span v-if="description" class="mu-spin-box__text">{{ description }}</span>
    </div>
  </div>
  <span v-else-if="show" class="mu-spin-inline" role="status">
    <span class="i-lucide-loader-circle mu-spin mu-spin-icon" :style="{ fontSize: `${px(size)}px` }" :aria-label="text.loading" />
    <span v-if="description" class="mu-spin-box__text">{{ description }}</span>
  </span>
</template>

<style>
.mu-spin-box { position: relative; }
.mu-spin-box__content--busy { opacity: 0.45; pointer-events: none; transition: opacity 0.2s; }

.mu-spin-box__mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.mu-spin-inline { display: inline-flex; align-items: center; gap: 8px; }
.mu-spin-icon { color: var(--primary); }
.mu-spin-box__text { color: var(--fg2); font-size: 13px; }
</style>
