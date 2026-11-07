<script setup lang="ts">
import { Button, Form, FormItem, Input, Select, useToast } from '@mushin/ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../api'
import type { ProviderDraft, ProviderType } from '../types'
import { modelOptions as toOptions } from '../models'
import ModelCaps from './ModelCaps.vue'
import PresetGrid from './PresetGrid.vue'
import { localize } from '../utils'
import SchemaForm from './SchemaForm.vue'

const props = defineProps<{
  types: ProviderType[]
  /** Saved provider id, used to fetch models with the stored (masked) key. */
  providerId?: string
}>()

const draft = defineModel<ProviderDraft>({ required: true })
const { t, locale } = useI18n()
const message = useToast()

const presetId = ref<string>()
const fetching = ref(false)
/** Models from the last fetch, offered in the selects without being added. */
const fetched = ref<string[]>([])

const type = computed(() => props.types.find((item) => item.id === draft.value.type))

const typeOptions = computed(() => props.types.map((item) => ({ label: localize(item.displayName, locale.value), value: item.id })))

const modelOptions = computed(() => toOptions([...new Set([...draft.value.models, ...fetched.value])]))

function applyPreset(value: string) {
  presetId.value = value
  if (value === 'custom') {
    // Start from scratch on the current type, so its fields stay in view.
    draft.value = { name: '', type: draft.value.type || props.types[0]?.id || '', config: {}, models: [] }
    fetched.value = []
    return
  }
  const [typeId, id] = value.split(':')
  const preset = props.types.find((item) => item.id === typeId)?.presets.find((item) => item.id === id)
  if (!preset) return
  draft.value = {
    name: localize(preset.label, locale.value),
    type: typeId,
    config: { ...preset.config },
    models: [...(preset.models ?? [])],
    defaultModel: preset.models?.[0],
  }
}

function setType(id: string) {
  draft.value = { ...draft.value, type: id, config: {} }
}

async function fetchModels() {
  fetching.value = true
  try {
    const input = props.providerId ? { provider: props.providerId } : { type: draft.value.type, config: draft.value.config }
    const models = await call<string[]>('providers.models', input)
    if (!models.length) {
      message.warning(t('providers.noModels'))
      return
    }
    fetched.value = models
    // Models already entered are kept; the fetched ones are offered in the list to add.
    if (draft.value.models.length) {
      message.success(t('providers.modelsFetchedKept', { count: models.length }))
      return
    }
    draft.value = { ...draft.value, models, defaultModel: draft.value.defaultModel || models[0] }
    message.success(t('providers.modelsFetched', { count: models.length }))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    fetching.value = false
  }
}

function setModels(models: string[]) {
  draft.value = { ...draft.value, models, defaultModel: draft.value.defaultModel || models[0] }
}

function clearModels() {
  draft.value = { ...draft.value, models: [] }
}
</script>

<template>
  <div class="provider-form">
    <Form>
      <FormItem v-if="!providerId" :label="t('providers.preset')">
        <PresetGrid :types="types" :value="presetId" @select="applyPreset" />
      </FormItem>
      <FormItem :label="t('common.name')" required>
        <Input v-model:value="draft.name" />
      </FormItem>
      <FormItem :label="t('common.type')" required>
        <Select :value="draft.type" :options="typeOptions" @update:value="setType" />
      </FormItem>
    </Form>

    <SchemaForm
      v-if="type"
      v-model="draft.config"
      :schema="type.configSchema"
      :secrets="type.secrets"
    />

    <Form>
      <FormItem :label="t('providers.models')" :feedback="t('providers.modelsHint')">
        <div class="models">
          <Select
            :value="draft.models"
            :options="modelOptions"
            multiple
            filterable
            tag
            :placeholder="t('providers.modelsPlaceholder')"
            @update:value="setModels"
          >
            <template #option="{ option }">
              <span class="model-label"><span class="model-label-name">{{ option.label }}</span><ModelCaps :model="String(option.value)" /></span>
            </template>
            <template #tag="{ label }">
              <span class="model-label"><span class="model-label-name">{{ label }}</span><ModelCaps :model="label" /></span>
            </template>
          </Select>
          <div class="model-actions">
            <Button size="small" icon="i-lucide-download" :loading="fetching" :disabled="!draft.type" @click="fetchModels">{{ t('providers.fetchModels') }}</Button>
            <Button size="small" :disabled="!draft.models.length" @click="clearModels">{{ t('providers.clearModels') }}</Button>
          </div>
        </div>
      </FormItem>
      <FormItem :label="t('providers.defaultModel')" :feedback="t('providers.defaultModelHint')">
        <Select
          :value="draft.defaultModel || null"
          :options="modelOptions"
          filterable
          tag
          clearable
          :placeholder="t('profiles.typeOrPick')"
          @update:value="(value: string | null) => (draft = { ...draft, defaultModel: value ?? '' })"
        >
          <template #option="{ option }">
            <span class="model-label"><span class="model-label-name">{{ option.label }}</span><ModelCaps :model="String(option.value)" /></span>
          </template>
        </Select>
      </FormItem>
    </Form>
  </div>
</template>

<style scoped>
/* The fixed fields, the type's own fields and the models read as one form. */
.provider-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.models {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.model-actions {
  display: flex;
  gap: 8px;
}
</style>
