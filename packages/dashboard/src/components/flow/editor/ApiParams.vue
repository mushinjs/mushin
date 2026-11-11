<script setup lang="ts">
/**
 * An API's params as one field each, for APIs the platform's table knows: required ones first,
 * the rest under "more". Whole numbers, yes/no and params with listed values hold one value: a
 * literal typed in (or picked) or one reference. The node still stores the params as JSON,
 * written back from the fields; see `writeParams`.
 */
import { Button, FormItem, Select, Toggle } from '@mushinjs/ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { localize } from '../../../utils'
import VarInput from '../VarInput.vue'
import { type ApiInfo, type ApiParam, readParams, singleValued, writeParams } from './checks'

const props = defineProps<{
  api: ApiInfo
  /** The params JSON as stored. */
  text: string
  problemOf(name: string): { message: string; severity: 'error' | 'warning' } | undefined
}>()
const emit = defineEmits<{ update: [text: string]; raw: [] }>()
const { t, locale } = useI18n()

const values = computed(() => readParams(props.text) ?? {})
const showMore = ref(false)
/** Yes/no params and ones with listed values switched to the reference editor, by name. */
const asRef = ref(new Set<string>())

const required = computed(() => props.api.params.filter((param) => param.required))
const optional = computed(() => props.api.params.filter((param) => !param.required))
const shownOptional = computed(() => optional.value.filter((param) => showMore.value || values.value[param.name] !== undefined))
const hiddenCount = computed(() => optional.value.length - shownOptional.value.length)

function set(name: string, value: string | undefined) {
  const next = { ...values.value }
  if (value === undefined || value === '') delete next[name]
  else next[name] = value
  emit('update', writeParams(next, props.api))
}

const isRef = (value: string | undefined) => !!value?.includes('{{')
const title = (param: ApiParam) => localize(param.title, locale.value)
/** Whether a param shows its switch or list of values rather than the text editor. */
const choice = (param: ApiParam) => (param.type === 'boolean' || !!param.options) && !isRef(values.value[param.name]) && !asRef.value.has(param.name)
const useRef = (name: string) => (asRef.value = new Set([...asRef.value, name]))
const placeholder = (param: ApiParam) => {
  const open = { open: '{{' }
  if (param.type === 'int') return t('flows.apiParams.intPlaceholder', open)
  return param.required ? t('flows.apiParams.requiredPlaceholder', open) : t('flows.apiParams.optionalPlaceholder')
}
const note = computed(() => (props.api.note ? localize(props.api.note, locale.value) : ''))
</script>

<template>
  <div class="api-params">
    <div class="params-head">
      <span class="params-title">{{ t('flows.apiParams.title') }}</span>
      <Button text size="tiny" @click="emit('raw')">{{ t('flows.apiParams.raw') }}</Button>
    </div>
    <p v-if="note" class="state note">{{ note }}</p>
    <p v-if="!api.params.length" class="state">{{ t('flows.apiParams.none') }}</p>
    <FormItem
      v-for="param in [...required, ...shownOptional]"
      :key="param.name"
      :required="param.required"
      :feedback="problemOf(param.name)?.message"
      :validation-status="problemOf(param.name)?.severity"
    >
      <template #label>
        <span class="param-name">{{ param.name }}</span>
        <span v-if="title(param) && title(param) !== param.name" class="param-title">{{ title(param) }}</span>
        <span v-if="param.default !== undefined && param.default !== ''" class="param-default">{{ t('flows.apiParams.default', { value: String(param.default) }) }}</span>
      </template>
      <div v-if="choice(param) && param.type === 'boolean'" class="switch-row">
        <Toggle size="small" :value="values[param.name] === 'true'" :aria-label="param.name" @update:value="(on: boolean) => set(param.name, String(on))" />
        <span v-if="values[param.name] === undefined" class="state">{{ t('flows.apiParams.unset') }}</span>
        <Button v-if="values[param.name] !== undefined" text size="tiny" @click="set(param.name, undefined)">{{ t('flows.apiParams.clear') }}</Button>
        <Button text size="tiny" class="ref-switch" :title="t('flows.varsInsert')" @click="useRef(param.name)">(x)</Button>
      </div>
      <div v-else-if="choice(param)" class="switch-row">
        <Select
          size="small"
          class="choice"
          :value="values[param.name] ?? null"
          :options="param.options!.map((option) => ({ label: option, value: option }))"
          :placeholder="param.required ? t('flows.apiParams.pick') : t('flows.apiParams.unset')"
          clearable
          @update:value="(next: string | null) => set(param.name, next ?? undefined)"
        />
        <Button text size="tiny" class="ref-switch" :title="t('flows.varsInsert')" @click="useRef(param.name)">(x)</Button>
      </div>
      <VarInput
        v-else
        :model-value="values[param.name] ?? ''"
        :multiline="param.type === 'message' || param.type === 'array' || param.type === 'object'"
        :mono="param.type === 'array' || param.type === 'object'"
        :single="singleValued(param)"
        :accept="param"
        :placeholder="placeholder(param)"
        :status="problemOf(param.name)?.severity"
        @update:model-value="(value: string) => set(param.name, value)"
      />
    </FormItem>
    <Button v-if="optional.length && (hiddenCount || showMore)" text size="tiny" class="more" @click="showMore = !showMore">
      {{ showMore ? t('flows.apiParams.less') : t('flows.apiParams.more', { count: hiddenCount }) }}
    </Button>
  </div>
</template>

<style scoped>
.api-params {
  display: grid;
  gap: 2px;
  margin-bottom: 14px;
}

.params-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.params-title {
  font-size: 13px;
  font-weight: 500;
}

.param-name {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
}

.param-title {
  margin-left: 6px;
  color: var(--fg3);
  font-size: 12px;
  font-weight: 400;
}

.switch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
}

.state {
  margin: 0;
  color: var(--fg3);
  font-size: 12px;
}

.param-default {
  margin-left: 6px;
  color: var(--fg3);
  font-size: 11px;
  font-weight: 400;
}

.note {
  margin-bottom: 6px;
}

.choice {
  flex: 1;
  min-width: 0;
}

.ref-switch {
  margin-left: auto;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  color: var(--primary);
}

.more {
  justify-self: start;
}
</style>
