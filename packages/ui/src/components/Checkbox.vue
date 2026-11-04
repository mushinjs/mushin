<script setup lang="ts">
/** A checkbox with its label as the default slot. */
import { CheckboxIndicator, CheckboxRoot } from 'reka-ui'
import type { Size } from '../config'

withDefaults(defineProps<{
  checked?: boolean
  indeterminate?: boolean
  disabled?: boolean
  size?: Size
}>(), { checked: false, size: 'medium' })

const emit = defineEmits<{ 'update:checked': [value: boolean] }>()
</script>

<template>
  <label class="mu-check" :class="[`mu-check--${size}`, { 'is-disabled': disabled }]">
    <CheckboxRoot
      class="mu-check__box"
      :model-value="indeterminate ? 'indeterminate' : checked"
      :disabled="disabled"
      @update:model-value="(value) => emit('update:checked', value === true)"
    >
      <CheckboxIndicator class="mu-check__mark">
        <span :class="indeterminate ? 'i-lucide-minus' : 'i-lucide-check'" />
      </CheckboxIndicator>
    </CheckboxRoot>
    <span v-if="$slots.default" class="mu-check__label"><slot /></span>
  </label>
</template>

<style>
.mu-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--fg);
  font-size: 14px;
  line-height: 1.4;
  cursor: pointer;
  user-select: none;
}

.mu-check--small,
.mu-check--tiny { gap: 6px; font-size: 13px; }
.mu-check.is-disabled { opacity: 0.5; cursor: not-allowed; }

.mu-check__box {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1.5px solid var(--line-strong);
  border-radius: 4px;
  background: var(--s1);
  color: var(--primary-fg);
  cursor: inherit;
  transition: background-color 0.15s, border-color 0.15s, box-shadow 0.15s;
}

.mu-check:hover .mu-check__box { border-color: var(--primary); }
.mu-check__box:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--focus); }
.mu-check__box[data-state='checked'],
.mu-check__box[data-state='indeterminate'] { border-color: var(--primary); background: var(--primary); }
.mu-check__mark { display: inline-flex; font-size: 12px; }
</style>
