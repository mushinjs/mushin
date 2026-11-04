<script setup lang="ts">
/** One button of a RadioGroup. */
import { RadioGroupItem } from 'reka-ui'
import { inject } from 'vue'
import { RADIO_GROUP } from './radio'

defineProps<{ value: string | number | boolean; disabled?: boolean; icon?: string }>()
const group = inject(RADIO_GROUP)!
</script>

<template>
  <RadioGroupItem class="mu-radio" :value="group.encode(value) as any" :disabled="disabled">
    <span v-if="icon" :class="icon" />
    <slot />
  </RadioGroupItem>
</template>

<style>
.mu-radio {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  box-sizing: border-box;
  min-height: calc(var(--h) - 4px);
  padding: 0 12px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--fg2);
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s, box-shadow 0.15s;
}

.mu-radios--tiny .mu-radio { padding: 0 7px; font-size: 12px; border-radius: 4px; }
.mu-radios--small .mu-radio { padding: 0 10px; font-size: 13px; }
.mu-radio:not([data-state='checked']):not([data-disabled]):hover { color: var(--fg); }
.mu-radio:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--focus); }
.mu-radio[data-state='checked'] { background: var(--raised); color: var(--primary); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
.mu-radio[data-disabled] { cursor: not-allowed; opacity: 0.5; }
</style>
