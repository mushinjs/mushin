<script setup lang="ts">
import { Form } from '@mushinjs/ui'
import { computed, watch } from 'vue'
import { differsFromDefault } from '../plugins/config'
import type { JsonSchema } from '../types'
import SchemaField from './SchemaField.vue'

const props = defineProps<{
  schema: JsonSchema
  modelValue: Record<string, any> | undefined
  /** Property names rendered as password inputs. */
  secrets?: string[]
  /** Property names to leave out of the form. */
  hidden?: string[]
  /** Dense layout for the flow editor; see SchemaField. */
  compact?: boolean
  /** Marks fields set to something other than their default, with a button to reset them. */
  markChanged?: boolean
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
  <Form class="schema-form" :class="{ compact }" :compact="compact">
    <SchemaField
      v-for="[name, field] in fields"
      :key="name"
      :name="name"
      :schema="field"
      :model-value="modelValue?.[name]"
      :required="required.has(name)"
      :secret="secrets?.includes(name) || field['x-secret'] === true"
      :compact="compact"
      :changed="markChanged && differsFromDefault(field, modelValue?.[name])"
      @update:model-value="(next: any) => update(name, next)"
      @reset="update(name, JSON.parse(JSON.stringify(field.default)))"
    />
  </Form>
</template>

<style scoped>
/* Space before whatever follows the last field. */
.schema-form:not(.compact) {
  margin-bottom: 24px;
}

.schema-form.compact {
  margin-bottom: 14px;
}

.schema-form:empty {
  display: none;
}
</style>
