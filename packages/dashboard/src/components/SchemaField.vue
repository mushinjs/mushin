<script setup lang="ts">
import { Button, FormItem, Input, NumberInput, RadioGroup, Select, TagsInput, Toggle, Tooltip } from '@mushin/ui'
import { computed, inject, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { JsonSchema } from '../types'
import { choicesOf } from '../choices'
import { humanize } from '../utils'
import SchemaForm from './SchemaForm.vue'
import { schemaFieldHooks } from './schemaHooks'

const props = defineProps<{
  name: string
  schema: JsonSchema
  modelValue: any
  required?: boolean
  secret?: boolean
  /**
   * The flow editor's dense layout: descriptions fold into an info icon by the label (unless the
   * field asks for an inline hint) and short choices fill the row as buttons.
   */
  compact?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: any] }>()
const { locale, t, te } = useI18n()

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

const hooks = inject(schemaFieldHooks, {})

const kind = computed(() => {
  const s = schema.value
  if (Array.isArray(s.enum)) return 'enum'
  if (s.type === 'string' && Array.isArray(s['x-apis'] ?? props.schema['x-apis'])) return 'apis'
  if (s.type === 'string' && (s['x-widget'] ?? props.schema['x-widget']) === 'json') return 'text'
  if (s.type === 'string' && (s['x-choices'] ?? props.schema['x-choices'])) return 'choices'
  if (s.type === 'string') return /prompt|template/i.test(props.name) || (s.maxLength ?? 0) > 200 ? 'text' : 'string'
  if (s.type === 'integer' || s.type === 'number') return 'number'
  if (s.type === 'boolean') return 'boolean'
  if (s.type === 'array' && s.items?.type === 'string') return s['x-choices'] ?? props.schema['x-choices'] ? 'multiChoices' : 'tags'
  if (s.type === 'object' && s.properties) return 'object'
  if (s.type === 'array' && s.items?.type === 'object' && s.items.properties) return 'list'
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
  const loaded = choicesOf(action).filter((choice) => !fixed.some((item) => item.value === choice.value))
  // Choices that name a group (such as providers and profiles) show under its heading.
  const groups = [...new Set(loaded.flatMap((choice) => (choice.group ? [choice.group] : [])))]
  if (!groups.length) return [...fixed, ...loaded]
  return [
    ...fixed,
    ...loaded.filter((choice) => !choice.group),
    ...groups.map((group) => ({
      type: 'group' as const,
      key: group,
      label: te(`choiceGroups.${group}`) ? t(`choiceGroups.${group}`) : group,
      children: loaded.filter((choice) => choice.group === group).map(({ value, label }) => ({ value, label })),
    })),
  ]
})
/** Up to four short choices show as buttons (CJK characters count double); in compact forms they fill the row. */
const textWidth = (text: string) => [...text].reduce((sum, char) => sum + (/[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 2 : 1), 0)
const asButtons = computed(() => kind.value === 'enum' && options.value.length <= 4 && options.value.reduce((sum: number, option: { label: string }) => sum + textWidth(option.label), 0) <= 34)
const widget = computed(() => schema.value['x-widget'] ?? props.schema['x-widget'])
/** A platform's API list (`x-apis`), as `send_poke · 戳一戳`; other names can be typed. */
const apiOptions = computed(() => ((schema.value['x-apis'] ?? props.schema['x-apis'] ?? []) as { action: string; title: any }[])
  .map((api) => ({ value: api.action, label: `${api.action} · ${typeof api.title === 'string' ? api.title : api.title?.[locale.value] ?? api.title?.en ?? ''}` })))
/** What the surroundings found wrong with the value, such as the flow editor's checks. */
const problem = computed(() => hooks.problemOf?.(props.name))
/** Under the field: a problem, the JSON error, or the description (unless folded into the label's info icon). */
const feedback = computed(() => problem.value?.message || jsonError.value || (props.compact && !hintInline.value ? undefined : description.value))
/** Text settings go to the surroundings' editor when there is one; secrets keep the password input. */
const textEditor = computed(() => (!props.secret && (kind.value === 'string' || kind.value === 'text') ? hooks.textEditor : undefined))

// Lists of objects, such as the conditions of a database node: one small form per item.
const items = computed<Record<string, any>[]>(() => (Array.isArray(props.modelValue) ? props.modelValue : []))
function setItem(index: number, next: Record<string, any>) {
  value.value = items.value.map((item, position) => (position === index ? next : item))
}
function removeItem(index: number) {
  value.value = items.value.filter((_, position) => position !== index)
}
function addItem() {
  value.value = [...items.value, {}]
}

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
    jsonError.value = t('common.invalidJson')
  }
}
</script>

<template>
  <!-- On/off: the label and its toggle share one row. -->
  <div v-if="kind === 'boolean'" class="switch-row" :class="{ compact }">
    <div class="switch-text">
      <span class="switch-label">
        {{ label }}
        <span v-if="required" class="required" aria-hidden="true">*</span>
        <Tooltip v-if="compact && description && !hintInline">
          <template #trigger><span class="i-lucide-info info" tabindex="0" /></template>
          {{ description }}
        </Tooltip>
      </span>
      <span v-if="feedback" class="switch-desc">{{ feedback }}</span>
    </div>
    <Toggle :value="!!value" :size="compact ? 'small' : 'medium'" :aria-label="label" @update:value="(next: boolean) => (value = next)" />
  </div>
  <FormItem
    v-else
    :label="label"
    :required="required"
    :info="compact && !hintInline ? description : undefined"
    :feedback="feedback"
    :validation-status="problem?.severity ?? (jsonError ? 'error' : undefined)"
  >
    <component
      :is="textEditor"
      v-if="textEditor"
      :model-value="value ?? ''"
      :multiline="kind === 'text'"
      :mono="widget === 'json'"
      :placeholder="schema.default !== undefined && schema.default !== '' ? String(schema.default) : undefined"
      :status="problem?.severity"
      @update:model-value="(next: string) => (value = next)"
    />
    <Select
      v-else-if="kind === 'apis'"
      :value="value ?? ''"
      :size="compact ? 'small' : 'medium'"
      :options="apiOptions"
      filterable
      tag
      @update:value="(next: string | null) => (value = next ?? '')"
    />
    <RadioGroup v-else-if="asButtons" v-model:value="value" :size="compact ? 'small' : 'medium'" :block="compact" :options="options" />
    <Select
      v-else-if="kind === 'enum'"
      v-model:value="value"
      :size="compact ? 'small' : 'medium'"
      :options="options"
      :clearable="!required"
    />
    <Select
      v-else-if="kind === 'choices'"
      :value="value ?? ''"
      :size="compact ? 'small' : 'medium'"
      :options="choiceOptions as any"
      filterable
      tag
      :clearable="!required"
      @update:value="(next: string | null) => (value = next ?? '')"
    />
    <Input
      v-else-if="kind === 'string'"
      v-model:value="value"
      :size="compact ? 'small' : 'medium'"
      :type="secret ? 'password' : 'text'"
      :show-password-on="secret ? 'click' : undefined"
      :placeholder="schema.default !== undefined ? String(schema.default) : ''"
      :input-props="{ autocomplete: secret ? 'new-password' : 'off' }"
      clearable
    />
    <Input
      v-else-if="kind === 'text'"
      v-model:value="value"
      :size="compact ? 'small' : 'medium'"
      type="textarea"
      :autosize="{ minRows: 3, maxRows: 10 }"
    />
    <NumberInput
      v-else-if="kind === 'number'"
      v-model:value="value"
      :size="compact ? 'small' : 'medium'"
      :min="schema.minimum"
      :max="schema.maximum"
      :step="schema.type === 'integer' ? 1 : undefined"
      :precision="schema.type === 'integer' ? 0 : undefined"
      :placeholder="schema.default !== undefined ? String(schema.default) : ''"
      clearable
    />
    <TagsInput v-else-if="kind === 'tags'" v-model:value="value" :size="compact ? 'small' : 'medium'" />
    <Select
      v-else-if="kind === 'multiChoices'"
      :value="Array.isArray(value) ? value : []"
      :size="compact ? 'small' : 'medium'"
      :options="choiceOptions as any"
      multiple
      filterable
      clearable
      :tag="widget === 'people'"
      :placeholder="widget === 'people' ? t('common.peoplePlaceholder') : undefined"
      @update:value="(next: string[]) => (value = next)"
    />
    <div v-else-if="kind === 'object'" class="nested">
      <SchemaForm v-model="value" :schema="schema" :compact="compact" />
    </div>
    <div v-else-if="kind === 'list'" class="list">
      <div v-for="(item, index) in items" :key="index" class="list-item">
        <span class="list-index">{{ index + 1 }}</span>
        <SchemaForm class="list-form" :model-value="item" :schema="schema.items" :compact="compact" @update:model-value="(next) => setItem(index, next)" />
        <Button quaternary circle size="tiny" type="error" class="list-remove" icon="i-lucide-trash-2" :aria-label="t('common.delete')" @click="removeItem(index)" />
      </div>
      <Button dashed size="small" block icon="i-lucide-plus" @click="addItem">{{ t('common.add') }}</Button>
    </div>
    <Input
      v-else
      :value="jsonText"
      type="textarea"
      class="mono"
      :size="compact ? 'small' : 'medium'"
      :autosize="{ minRows: 2, maxRows: 10 }"
      placeholder="{}"
      :status="jsonError ? 'error' : undefined"
      @update:value="onJson"
    />
  </FormItem>
</template>

<style scoped>
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 34px;
}

.switch-row.compact {
  min-height: 28px;
}

.switch-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.switch-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--fg);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
}

.switch-desc {
  color: var(--fg3);
  font-size: 12px;
  line-height: 1.5;
}

.required {
  color: var(--bad);
}

.info {
  color: var(--fg3);
  font-size: 13px;
  cursor: help;
}

.info:hover,
.info:focus-visible {
  color: var(--fg2);
  outline: none;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.list-item {
  position: relative;
  display: flex;
  gap: 8px;
  padding: 10px 32px 10px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--s1);
}

.list-index {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 50%;
  background: var(--s2);
  color: var(--fg3);
  font-size: 11px;
  font-family: var(--mono);
}

.list-form {
  flex: 1;
  min-width: 0;
}

.list-remove {
  position: absolute;
  top: 6px;
  right: 6px;
}

.nested {
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--s1);
}
</style>
