<script setup lang="ts">
/**
 * A choice among a few values, drawn as joined buttons (a segmented control). Give `options`, or
 * put RadioButton children inside.
 */
import { RadioGroupRoot } from 'reka-ui'
import { computed, provide } from 'vue'
import type { Size } from '../config'
import RadioButton from './RadioButton.vue'
import { RADIO_GROUP } from './radio'

type Value = string | number | boolean

const props = withDefaults(defineProps<{
  value?: Value | null
  options?: { label: string; value: Value; disabled?: boolean; icon?: string }[]
  size?: Size
  disabled?: boolean
  /** Stretches the buttons to fill the row. */
  block?: boolean
}>(), { size: 'medium' })

const emit = defineEmits<{ 'update:value': [value: any] }>()

// Reka's radio group takes strings and numbers; booleans are carried as text.
const encode = (value: Value | null | undefined) => (typeof value === 'boolean' ? `bool:${value}` : value ?? undefined)
const decode = (value: unknown) => (value === 'bool:true' ? true : value === 'bool:false' ? false : value)
provide(RADIO_GROUP, { encode, size: computed(() => props.size) })
</script>

<template>
  <RadioGroupRoot
    class="mu-radios"
    :class="[`mu-radios--${size}`, { 'mu-radios--block': block }]"
    orientation="horizontal"
    :model-value="encode(value) as any"
    :disabled="disabled"
    @update:model-value="(next) => emit('update:value', decode(next))"
  >
    <slot>
      <RadioButton v-for="option in options" :key="String(option.value)" :value="option.value" :disabled="option.disabled" :icon="option.icon">
        {{ option.label }}
      </RadioButton>
    </slot>
  </RadioGroupRoot>
</template>

<style>
.mu-radios {
  --h: 34px;
  display: inline-flex;
  flex-wrap: wrap;
  box-sizing: border-box;
  max-width: 100%;
  min-height: var(--h);
  padding: 2px;
  gap: 2px;
  border-radius: var(--radius-sm);
  background: var(--s2);
}

.mu-radios--tiny { --h: 22px; }
.mu-radios--small { --h: 28px; }
.mu-radios--large { --h: 40px; }
.mu-radios--block { display: flex; }
.mu-radios--block > * { flex: 1; }
.mu-radios[data-disabled] { opacity: 0.5; }
</style>
