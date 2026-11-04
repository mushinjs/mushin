<script setup lang="ts">
/** Editable key and value rows, such as environment variables or HTTP headers. */
import { useText } from '../config'
import Button from './Button.vue'
import Input from './Input.vue'

export interface KeyValue {
  key: string
  value: string
}

const props = withDefaults(defineProps<{
  value?: KeyValue[]
  keyPlaceholder?: string
  valuePlaceholder?: string
  size?: 'small' | 'medium'
  disabled?: boolean
}>(), { value: () => [], size: 'medium' })

const emit = defineEmits<{ 'update:value': [value: KeyValue[]] }>()
const text = useText()

function set(index: number, field: keyof KeyValue, next: string) {
  emit('update:value', props.value.map((row, i) => (i === index ? { ...row, [field]: next } : row)))
}
const add = (at = props.value.length) => emit('update:value', [...props.value.slice(0, at), { key: '', value: '' }, ...props.value.slice(at)])
const remove = (index: number) => emit('update:value', props.value.filter((_, i) => i !== index))
</script>

<template>
  <div class="mu-kv">
    <div v-for="(row, index) in value" :key="index" class="mu-kv__row">
      <Input :value="row.key" :size="size" :placeholder="keyPlaceholder" :disabled="disabled" class="mu-kv__key" @update:value="(next: string) => set(index, 'key', next)" />
      <Input :value="row.value" :size="size" :placeholder="valuePlaceholder" :disabled="disabled" class="mu-kv__value" @update:value="(next: string) => set(index, 'value', next)" />
      <Button :size="size" quaternary circle icon="i-lucide-minus" :aria-label="text.remove" :disabled="disabled" @click="remove(index)" />
      <Button :size="size" quaternary circle icon="i-lucide-plus" :aria-label="text.add" :disabled="disabled" @click="add(index + 1)" />
    </div>
    <Button v-if="!value.length" :size="size" dashed icon="i-lucide-plus" class="mu-kv__new" :disabled="disabled" @click="add()">{{ text.add }}</Button>
  </div>
</template>

<style>
.mu-kv {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.mu-kv__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.mu-kv__key { flex: 2 1 0; min-width: 0; }
.mu-kv__value { flex: 3 1 0; min-width: 0; }
.mu-kv__new { align-self: stretch; }
</style>
