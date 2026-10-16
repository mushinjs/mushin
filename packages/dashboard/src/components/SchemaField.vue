<script setup lang="ts">
import { NDynamicTags, NFormItem, NInput, NInputNumber, NSelect, NSwitch } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { JsonSchema } from '../types'
import { humanize } from '../utils'
import SchemaForm from './SchemaForm.vue'

const props = defineProps<{
  name: string
  schema: JsonSchema
  modelValue: any
  required?: boolean
  secret?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: any] }>()
const { locale } = useI18n()

const value = computed({
  get: () => props.modelValue,
  set: (next) => emit('update:modelValue', next),
})

/** Unwraps nullable unions (`anyOf: [T, {type: 'null'}]`) that zod produces for optional-nullable fields. */
const schema = computed<JsonSchema>(() => {
  const variants = props.schema.anyOf ?? props.schema.oneOf
  if (Array.isArray(variants)) {
    const concrete = variants.filter((variant: JsonSchema) => variant.type !== 'null')
    if (concrete.length === 1) return { ...concrete[0], description: props.schema.description ?? concrete[0].description, default: props.schema.default }
  }
  return props.schema
})

const kind = computed(() => {
  const s = schema.value
  if (Array.isArray(s.enum)) return 'enum'
  if (s.type === 'string') return /prompt|template/i.test(props.name) || (s.maxLength ?? 0) > 200 ? 'text' : 'string'
  if (s.type === 'integer' || s.type === 'number') return 'number'
  if (s.type === 'boolean') return 'boolean'
  if (s.type === 'array' && s.items?.type === 'string') return 'tags'
  if (s.type === 'object' && s.properties) return 'object'
  return 'json'
})

// Plugins attach translations under `x-i18n` (see `field()` in @mushin/core).
const translated = computed(() => schema.value['x-i18n']?.[locale.value] ?? props.schema['x-i18n']?.[locale.value] ?? {})
const label = computed(() => translated.value.title ?? schema.value.title ?? props.schema.title ?? humanize(props.name))
const description = computed(() => translated.value.description ?? schema.value.description ?? props.schema.description)

// Free-form values (records, mixed arrays) are edited as JSON text.
const jsonText = ref('')
const jsonError = ref('')
watch(() => props.modelValue, (next) => {
  if (kind.value !== 'json') return
  try {
    if (JSON.stringify(JSON.parse(jsonText.value || 'null')) === JSON.stringify(next ?? null)) return
  } catch {}
  jsonText.value = next === undefined ? '' : JSON.stringify(next, null, 2)
}, { immediate: true })

function onJson(text: string) {
  jsonText.value = text
  if (!text.trim()) {
    jsonError.value = ''
    value.value = undefined
    return
  }
  try {
    value.value = JSON.parse(text)
    jsonError.value = ''
  } catch {
    jsonError.value = 'Invalid JSON'
  }
}
</script>

<template>
  <NFormItem
    :label="label"
    :required="required"
    :feedback="jsonError || description"
    :validation-status="jsonError ? 'error' : undefined"
  >
    <NSelect
      v-if="kind === 'enum'"
      v-model:value="value"
      :options="schema.enum.map((option: string) => ({ label: String(option), value: option }))"
      :clearable="!required"
    />
    <NInput
      v-else-if="kind === 'string'"
      v-model:value="value"
      :type="secret ? 'password' : 'text'"
      :show-password-on="secret ? 'click' : undefined"
      :placeholder="schema.default !== undefined ? String(schema.default) : ''"
      :input-props="{ autocomplete: secret ? 'new-password' : 'off' }"
      clearable
    />
    <NInput
      v-else-if="kind === 'text'"
      v-model:value="value"
      type="textarea"
      :autosize="{ minRows: 3, maxRows: 10 }"
    />
    <NInputNumber
      v-else-if="kind === 'number'"
      v-model:value="value"
      :min="schema.minimum"
      :max="schema.maximum"
      :step="schema.type === 'integer' ? 1 : undefined"
      :precision="schema.type === 'integer' ? 0 : undefined"
      :placeholder="schema.default !== undefined ? String(schema.default) : ''"
      clearable
      style="width: 100%"
    />
    <NSwitch v-else-if="kind === 'boolean'" v-model:value="value" />
    <NDynamicTags v-else-if="kind === 'tags'" v-model:value="value" />
    <div v-else-if="kind === 'object'" class="nested">
      <SchemaForm v-model="value" :schema="schema" />
    </div>
    <NInput
      v-else
      :value="jsonText"
      type="textarea"
      class="mono"
      :autosize="{ minRows: 2, maxRows: 10 }"
      placeholder="{}"
      @update:value="onJson"
    />
  </NFormItem>
</template>

<style scoped>
.nested {
  width: 100%;
  padding: 12px 12px 0;
  border: 1px dashed rgba(127, 127, 127, 0.3);
  border-radius: 8px;
}
</style>
