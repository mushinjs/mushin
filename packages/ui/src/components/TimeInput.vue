<script setup lang="ts">
/**
 * A time of day as "HH:mm". Typing is forgiving ("930", "9:30" and "21.05" all work); the text is
 * tidied when the field loses focus, and text that is not a time goes back to the last good value.
 * A text field rather than <input type="time">, which some webviews draw as a plain box anyway.
 */
import { ref, watch } from 'vue'
import type { Size } from '../config'
import Input from './Input.vue'

const props = withDefaults(defineProps<{
  value?: string | null
  size?: Size
  placeholder?: string
  clearable?: boolean
  disabled?: boolean
}>(), { size: 'medium', placeholder: 'HH:mm' })

const emit = defineEmits<{ 'update:value': [value: string | null] }>()
const text = ref(props.value ?? '')
watch(() => props.value, (value) => (text.value = value ?? ''))

/** "HH:mm" for what was typed, or undefined when it is not a time. */
function parse(input: string): string | undefined {
  const digits = input.trim().replace(/[.:：\s]/g, ':')
  const match = /^(\d{1,2}):?(\d{2})$/.exec(digits.includes(':') ? digits : digits.length <= 2 ? `${digits}:00` : digits)
  if (!match) return
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function commit() {
  if (!text.value.trim()) {
    if (props.value) emit('update:value', null)
    return
  }
  const time = parse(text.value)
  if (time && time !== props.value) emit('update:value', time)
  text.value = time ?? props.value ?? ''
}

function onUpdate(value: string) {
  text.value = value
  if (!value) emit('update:value', null)
}
</script>

<template>
  <Input
    class="mu-time"
    :value="text"
    :size="size"
    :placeholder="placeholder"
    :clearable="clearable"
    :disabled="disabled"
    :maxlength="5"
    :input-props="{ inputmode: 'numeric', autocomplete: 'off' }"
    @update:value="onUpdate"
    @blur="commit"
    @keydown.enter="commit"
  >
    <template #prefix><span class="i-lucide-clock" /></template>
  </Input>
</template>

<style>
.mu-time { width: 116px; }
.mu-time.mu-input--small { width: 104px; }
</style>
