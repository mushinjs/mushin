<script setup lang="ts">
import { InformationCircleOutline } from '@vicons/ionicons5'
import { NCheckbox, NDynamicTags, NFormItem, NIcon, NInput, NInputNumber, NRadioButton, NRadioGroup, NSelect, NSwitch, NTooltip } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { JsonSchema } from '../types'
import { choicesOf } from '../choices'
import { humanize } from '../utils'
import SchemaForm from './SchemaForm.vue'

const props = defineProps<{
  name: string
  schema: JsonSchema
  modelValue: any
  required?: boolean
  secret?: boolean
  /**
   * The flow editor's dense layout: descriptions fold into a hint icon, booleans are checkboxes
   * (or a switch on the label's row), and short choices are buttons.
   */
  compact?: boolean
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
  if (s.type === 'string' && (s['x-choices'] ?? props.schema['x-choices'])) return 'choices'
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
const hintInline = computed(() => (schema.value['x-hint'] ?? props.schema['x-hint']) === 'inline')

/** An enum value's label: translated, then the plugin's English label, then the value itself. */
const optionLabel = (option: string) => translated.value.options?.[option] ?? (schema.value['x-options'] ?? props.schema['x-options'])?.[option] ?? String(option)
const options = computed(() => (schema.value.enum ?? []).map((option: string) => ({ label: optionLabel(option), value: option })))
/** Values from the field's `x-choices` action, after its fixed `x-options` (such as "none"). Typing other text is allowed. */
const choiceOptions = computed(() => {
  const action = schema.value['x-choices'] ?? props.schema['x-choices']
  if (!action) return []
  const fixed = Object.keys(schema.value['x-options'] ?? props.schema['x-options'] ?? {}).map((option) => ({ label: optionLabel(option), value: option }))
  return [...fixed, ...choicesOf(action).filter((choice) => !fixed.some((item) => item.value === choice.value))]
})
/** In compact forms, up to four choices show as buttons. */
const asButtons = computed(() => props.compact && kind.value === 'enum' && options.value.length <= 4)
const widget = computed(() => schema.value['x-widget'] ?? props.schema['x-widget'] ?? 'checkbox')

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
  <!-- Compact checkbox: the label sits next to the box, the description in its hint. -->
  <div v-if="compact && kind === 'boolean' && widget === 'checkbox'" class="check">
    <NCheckbox :checked="!!value" @update:checked="(next: boolean) => (value = next)">{{ label }}</NCheckbox>
    <NTooltip v-if="description" :style="{ maxWidth: '280px' }">
      <template #trigger><NIcon :size="14" class="hint"><InformationCircleOutline /></NIcon></template>
      {{ description }}
    </NTooltip>
  </div>
  <NFormItem
    v-else
    :required="required"
    :label-placement="compact && kind === 'boolean' ? 'left' : undefined"
    :show-feedback="!compact || !!jsonError || (hintInline && !!description)"
    :feedback="jsonError || (compact && !hintInline ? undefined : description)"
    :validation-status="jsonError ? 'error' : undefined"
  >
    <template #label>
      <span class="label">
        {{ label }}
        <NTooltip v-if="compact && description && !hintInline" :style="{ maxWidth: '280px' }">
          <template #trigger><NIcon :size="14" class="hint"><InformationCircleOutline /></NIcon></template>
          {{ description }}
        </NTooltip>
      </span>
    </template>
    <NRadioGroup v-if="asButtons" v-model:value="value" size="small" class="choices">
      <NRadioButton v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</NRadioButton>
    </NRadioGroup>
    <NSelect
      v-else-if="kind === 'enum'"
      v-model:value="value"
      :options="options"
      :clearable="!required"
    />
    <NSelect
      v-else-if="kind === 'choices'"
      :value="value ?? ''"
      :options="choiceOptions"
      filterable
      tag
      @update:value="(next: string | null) => (value = next ?? '')"
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
.label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.hint {
  opacity: 0.5;
  cursor: help;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0 16px 10px 0;
}

.choices {
  flex-wrap: wrap;
}

.nested {
  width: 100%;
  padding: 12px 12px 0;
  border: 1px dashed rgba(127, 127, 127, 0.3);
  border-radius: 8px;
}
</style>
