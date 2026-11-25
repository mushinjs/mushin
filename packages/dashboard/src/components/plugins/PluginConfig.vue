<script setup lang="ts">
import { Button, Input, RadioGroup, useToast } from '@mushinjs/ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../../api'
import { inferSchema, isSecretField, jsonProblem, type JsonProblem } from '../../plugins/config'
import { prefs } from '../../prefs'
import type { AppPlugin, JsonSchema } from '../../types'
import { clone } from '../../utils'
import SchemaForm from '../SchemaForm.vue'

/**
 * A plugin's settings in the details panel, as a form or as JSON (the choice is kept in this browser). Plugins
 * without a schema get a form worked out from their current values. Saving restarts the plugin.
 */
const props = defineProps<{ plugin: AppPlugin }>()
const emit = defineEmits<{ saved: [] }>()
const { t } = useI18n()
const message = useToast()

const inferred = computed(() => !props.plugin.configSchema)
const schema = computed<JsonSchema>(() => props.plugin.configSchema ?? inferSchema(props.plugin.config))
const empty = computed(() => !Object.keys(schema.value.properties ?? {}).length)
const secrets = computed(() => (inferred.value ? Object.keys(props.plugin.config ?? {}).filter((key) => isSecretField(key)) : []))

/** The saved config with schema defaults filled in, as the form shows it. */
function baseline() {
  const value: Record<string, any> = clone(props.plugin.config ?? {})
  for (const [name, field] of Object.entries<JsonSchema>(schema.value.properties ?? {})) {
    if (value[name] === undefined && field.default !== undefined) value[name] = clone(field.default)
  }
  return value
}

const draft = ref<Record<string, any>>({})
const jsonText = ref('')
const problem = ref<JsonProblem>()
const saved = ref('')
const saving = ref(false)

function reset() {
  draft.value = baseline()
  jsonText.value = JSON.stringify(draft.value, null, 2)
  saved.value = JSON.stringify(draft.value)
  problem.value = undefined
}

watch(() => [props.plugin.id, props.plugin.package] as const, reset, { immediate: true })
// After a save (or a change from elsewhere) the list brings the new config; keep edits in progress.
watch(() => JSON.stringify(props.plugin.config), () => {
  if (!dirty.value) reset()
})

const mode = computed({
  get: () => prefs.pluginConfigMode,
  set: (next: 'form' | 'json') => {
    if (next === prefs.pluginConfigMode) return
    if (next === 'json') {
      jsonText.value = JSON.stringify(draft.value, null, 2)
      problem.value = undefined
    } else {
      // Back to the form only from JSON that parses, saying where it does not.
      problem.value = jsonProblem(jsonText.value)
      if (problem.value) return
      draft.value = JSON.parse(jsonText.value.trim() || '{}')
    }
    prefs.pluginConfigMode = next
  },
})

function onJson(text: string) {
  jsonText.value = text
  if (problem.value) problem.value = jsonProblem(text)
}

/** What would be saved now, or undefined while the JSON is wrong. */
const current = computed<Record<string, any> | undefined>(() => {
  if (mode.value === 'form') return draft.value
  try {
    const value = JSON.parse(jsonText.value.trim() || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
})

const dirty = computed(() => (current.value ? JSON.stringify(current.value) !== saved.value : true))

const problemText = computed(() => {
  const value = problem.value
  if (!value) return ''
  if (value.message === 'not an object') return t('plugins.config.notObject')
  return value.line ? t('plugins.config.invalidJsonAt', { line: value.line, column: value.column }) : t('plugins.config.invalidJson', { message: value.message })
})

async function save() {
  if (mode.value === 'json') {
    problem.value = jsonProblem(jsonText.value)
    if (problem.value) return
  }
  const config = current.value
  if (!config || !props.plugin.id) return
  saving.value = true
  try {
    await call('plugins.configure', { id: props.plugin.id, config })
    saved.value = JSON.stringify(config)
    message.success(t('common.saved'))
    emit('saved')
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="config">
    <div class="bar">
      <RadioGroup
        v-model:value="mode"
        size="small"
        :options="[{ label: t('plugins.config.form'), value: 'form' }, { label: t('plugins.config.json'), value: 'json' }]"
      />
      <span v-if="dirty && plugin.id" class="unsaved"><span class="dot" />{{ t('plugins.config.unsaved') }}</span>
    </div>

    <template v-if="mode === 'form'">
      <p v-if="empty" class="empty">{{ t('plugins.config.empty') }}</p>
      <template v-else>
        <p v-if="inferred" class="hint">{{ t('plugins.config.inferred') }}</p>
        <SchemaForm v-model="draft" :schema="schema" :secrets="secrets" :mark-changed="!inferred" />
      </template>
    </template>
    <div v-else class="json">
      <Input
        :value="jsonText"
        type="textarea"
        class="mono"
        :autosize="{ minRows: 8, maxRows: 28 }"
        :status="problem ? 'error' : undefined"
        @update:value="onJson"
      />
    </div>
    <p v-if="problem" class="problem" role="alert">{{ problemText }}</p>

    <p v-if="!plugin.id" class="hint">{{ t('plugins.config.enableFirst') }}</p>
    <div class="actions">
      <Button v-if="dirty && plugin.id" size="small" @click="reset">{{ t('plugins.config.discard') }}</Button>
      <Button type="primary" size="small" :loading="saving" :disabled="!plugin.id || !dirty" @click="save">{{ t('common.saveAndReload') }}</Button>
    </div>
  </div>
</template>

<style scoped>
.config {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.bar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.unsaved {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--warn);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.empty,
.hint {
  margin: 0;
  font-size: 13px;
  color: var(--fg3);
}

.empty {
  padding: 16px 0;
}

.json :deep(textarea) {
  font-family: var(--mono);
  font-size: 12.5px;
}

.problem {
  margin: 0;
  font-size: 12.5px;
  color: var(--bad);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* SchemaForm leaves room under itself for what follows; the buttons sit right below here. */
.config :deep(.schema-form) {
  margin-bottom: 0;
}
</style>
