<script setup lang="ts">
import { NForm } from 'naive-ui'
import { computed, watch } from 'vue'
import type { JsonSchema } from '../types'
import SchemaField from './SchemaField.vue'

const props = defineProps<{
  schema: JsonSchema
  modelValue: Record<string, any> | undefined
  /** Property names rendered as password inputs. */
  secrets?: string[]
  /** Property names to leave out of the form. */
  hidden?: string[]
}>()

const emit = defineEmits<{ 'update:modelValue': [value: Record<string, any>] }>()

const fields = computed(() => Object.entries<JsonSchema>(props.schema.properties ?? {})
  .filter(([name]) => !props.hidden?.includes(name)))

const required = computed(() => new Set<string>(props.schema.required ?? []))

// Fill in schema defaults once, so the form shows what will be saved.
watch(() => props.schema, () => {
  const value = { ...(props.modelValue ?? {}) }
  let changed = !props.modelValue
  for (const [name, field] of Object.entries<JsonSchema>(props.schema.properties ?? {})) {
    if (value[name] === undefined && field.default !== undefined) {
      value[name] = JSON.parse(JSON.stringify(field.default))
      changed = true
    }
  }
  if (changed) emit('update:modelValue', value)
}, { immediate: true })

function update(name: string, next: any) {
  const value = { ...(props.modelValue ?? {}) }
  if (next === undefined || next === null || next === '') delete value[name]
  else value[name] = next
  emit('update:modelValue', value)
}
</script>

<template>
  <NForm label-placement="top" size="medium">
    <SchemaField
      v-for="[name, field] in fields"
      :key="name"
      :name="name"
      :schema="field"
      :model-value="modelValue?.[name]"
      :required="required.has(name)"
      :secret="secrets?.includes(name)"
      @update:model-value="(next: any) => update(name, next)"
    />
  </NForm>
</template>
