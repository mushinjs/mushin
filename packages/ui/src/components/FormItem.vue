<script setup lang="ts">
/**
 * One field: its label (prop or #label slot), the control (default slot), and a line under it
 * for a description or an error (`feedback`). An `info` hint shows as an icon beside the label.
 */
import { computed, inject, useId } from 'vue'
import { FORM } from './form'
import Tooltip from './Tooltip.vue'

const props = defineProps<{
  label?: string
  required?: boolean
  feedback?: string
  /** A hint behind an info icon next to the label. */
  info?: string
  validationStatus?: 'error' | 'warning'
  labelPlacement?: 'top' | 'left'
  /** For a control that labels itself, such as a checkbox: no label row. */
  bare?: boolean
}>()

const form = inject(FORM, undefined)
const placement = computed(() => props.labelPlacement ?? form?.labelPlacement.value ?? 'top')
const width = computed(() => form?.labelWidth.value)
const id = useId()
</script>

<template>
  <div
    class="mu-field"
    :class="[`mu-field--${placement}`, { [`is-${validationStatus}`]: validationStatus }]"
    :style="placement === 'left' && width ? { '--label-width': typeof width === 'number' ? `${width}px` : width } : undefined"
  >
    <div v-if="!bare && (label || $slots.label)" :id="`${id}-label`" class="mu-field__label">
      <span class="mu-field__label-text"><slot name="label">{{ label }}</slot></span>
      <span v-if="required" class="mu-field__required" aria-hidden="true">*</span>
      <Tooltip v-if="info">
        <template #trigger><span class="i-lucide-info mu-field__info" tabindex="0" /></template>
        {{ info }}
      </Tooltip>
      <span v-if="$slots['label-extra']" class="mu-field__label-extra"><slot name="label-extra" /></span>
    </div>
    <div class="mu-field__control" :aria-labelledby="label || $slots.label ? `${id}-label` : undefined">
      <slot />
      <div v-if="feedback || $slots.feedback" class="mu-field__feedback"><slot name="feedback">{{ feedback }}</slot></div>
    </div>
  </div>
</template>

<style>
.mu-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }

.mu-field--left {
  display: grid;
  grid-template-columns: var(--label-width, auto) minmax(0, 1fr);
  align-items: start;
  column-gap: 12px;
}

.mu-field--left > .mu-field__label { min-height: 34px; }

.mu-field__label {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  color: var(--fg);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
}

.mu-field__label-text { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.mu-field__required { color: var(--bad); }
.mu-field__info { color: var(--fg3); font-size: 13px; cursor: help; }
.mu-field__info:hover,
.mu-field__info:focus-visible { color: var(--fg2); outline: none; }
.mu-field__label-extra { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }
.mu-field__control { display: flex; flex-direction: column; align-items: stretch; gap: 5px; min-width: 0; }
.mu-field__control > .mu-toggle,
.mu-field__control > .mu-radios,
.mu-field__control > .mu-check,
.mu-field__control > .mu-btn { align-self: flex-start; }
.mu-field__feedback { color: var(--fg3); font-size: 12px; line-height: 1.5; }
.mu-field.is-error .mu-field__feedback { color: var(--bad); }
.mu-field.is-warning .mu-field__feedback { color: var(--warn); }
</style>
