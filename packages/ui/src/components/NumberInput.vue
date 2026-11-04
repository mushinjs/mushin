<script setup lang="ts">
/** A number field with step buttons. Empty is `null`; typed text is applied on blur or Enter. */
import { computed, ref, watch } from 'vue'
import type { Size } from '../config'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  value?: number | null
  min?: number
  max?: number
  step?: number
  /** Digits after the point; 0 for whole numbers. */
  precision?: number
  size?: Size
  placeholder?: string
  clearable?: boolean
  disabled?: boolean
  showButton?: boolean
}>(), { step: 1, size: 'medium', showButton: true })

const emit = defineEmits<{ 'update:value': [value: number | null]; blur: [event: FocusEvent] }>()

const draft = ref('')
const format = (value: number | null | undefined) => (value === null || value === undefined ? '' : props.precision === undefined ? String(value) : value.toFixed(props.precision))
watch(() => props.value, (value) => (draft.value = format(value)), { immediate: true })

function clamp(value: number) {
  let next = value
  if (props.min !== undefined) next = Math.max(props.min, next)
  if (props.max !== undefined) next = Math.min(props.max, next)
  if (props.precision !== undefined) next = Number(next.toFixed(props.precision))
  return next
}

function commit() {
  const text = draft.value.trim()
  if (!text) {
    if (props.value !== null && props.value !== undefined) emit('update:value', null)
    return
  }
  const parsed = Number(text)
  if (Number.isNaN(parsed)) {
    draft.value = format(props.value)
    return
  }
  const next = clamp(parsed)
  draft.value = format(next)
  if (next !== props.value) emit('update:value', next)
}

function nudge(direction: 1 | -1) {
  const base = props.value ?? props.min ?? 0
  emit('update:value', clamp(base + direction * props.step))
}

const atMin = computed(() => props.min !== undefined && (props.value ?? props.min) <= props.min)
const atMax = computed(() => props.max !== undefined && (props.value ?? -Infinity) >= props.max)
</script>

<template>
  <div class="mu-input mu-number" :class="[`mu-input--${size}`, { 'is-disabled': disabled }, $attrs.class]" :style="$attrs.style as any">
    <input
      v-model="draft"
      class="mu-input__field"
      inputmode="decimal"
      :placeholder="placeholder"
      :disabled="disabled"
      :aria-valuemin="min"
      :aria-valuemax="max"
      :aria-valuenow="value ?? undefined"
      role="spinbutton"
      @blur="commit(); $emit('blur', $event)"
      @keydown.enter="commit"
      @keydown.up.prevent="nudge(1)"
      @keydown.down.prevent="nudge(-1)"
    >
    <button v-if="clearable && value !== null && value !== undefined && !disabled" type="button" class="mu-input__clear" tabindex="-1" @click="$emit('update:value', null)">
      <span class="i-lucide-circle-x" />
    </button>
    <span v-if="showButton" class="mu-number__steps">
      <button type="button" tabindex="-1" :disabled="disabled || atMin" aria-label="−" @click="nudge(-1)"><span class="i-lucide-minus" /></button>
      <button type="button" tabindex="-1" :disabled="disabled || atMax" aria-label="+" @click="nudge(1)"><span class="i-lucide-plus" /></button>
    </span>
  </div>
</template>

<style>
.mu-number { padding-right: 3px; }

.mu-number__steps {
  display: inline-flex;
  gap: 1px;
}

.mu-number__steps button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(var(--h) - 10px);
  height: calc(var(--h) - 10px);
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fg2);
  font-size: 13px;
  cursor: pointer;
}

.mu-number__steps button:not(:disabled):hover { background: var(--s3); color: var(--fg); }
.mu-number__steps button:disabled { opacity: 0.35; cursor: not-allowed; }
</style>
