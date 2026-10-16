<script setup lang="ts">
import { NButton, NForm, NFormItem, NInput, NSelect, NSpace, useMessage } from 'naive-ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../api'
import type { ProviderDraft, ProviderType } from '../types'
import { localize } from '../utils'
import SchemaForm from './SchemaForm.vue'

const props = defineProps<{
  types: ProviderType[]
  /** Saved provider id, used to fetch models with the stored (masked) key. */
  providerId?: string
}>()

const draft = defineModel<ProviderDraft>({ required: true })
const { t, locale } = useI18n()
const message = useMessage()

const presetId = ref<string>()
const fetching = ref(false)

const type = computed(() => props.types.find((item) => item.id === draft.value.type))

const presetOptions = computed(() => props.types.flatMap((item) => item.presets.map((preset) => ({
  label: localize(preset.label, locale.value),
  value: `${item.id}:${preset.id}`,
}))))

const typeOptions = computed(() => props.types.map((item) => ({ label: localize(item.displayName, locale.value), value: item.id })))

const modelOptions = computed(() => draft.value.models.map((model) => ({ label: model, value: model })))

function applyPreset(value: string) {
  presetId.value = value
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
    draft.value = { ...draft.value, models, defaultModel: models.includes(draft.value.defaultModel ?? '') ? draft.value.defaultModel : models[0] }
    message.success(t('providers.modelsFetched', { count: models.length }))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    fetching.value = false
  }
}

function setModels(models: string[]) {
  draft.value = {
    ...draft.value,
    models,
    defaultModel: models.includes(draft.value.defaultModel ?? '') ? draft.value.defaultModel : models[0],
  }
}
</script>

<template>
  <div class="provider-form">
    <NForm label-placement="top">
      <NFormItem v-if="!providerId" :label="t('providers.preset')">
        <NSelect :value="presetId" :options="presetOptions" :placeholder="t('providers.presetHint')" filterable @update:value="applyPreset" />
      </NFormItem>
      <NFormItem :label="t('common.name')" required>
        <NInput v-model:value="draft.name" />
      </NFormItem>
      <NFormItem :label="t('common.type')" required>
        <NSelect :value="draft.type" :options="typeOptions" @update:value="setType" />
      </NFormItem>
    </NForm>

    <SchemaForm
      v-if="type"
      v-model="draft.config"
      :schema="type.configSchema"
      :secrets="type.secrets"
    />

    <NForm label-placement="top">
      <NFormItem :label="t('providers.models')" :feedback="t('providers.modelsHint')">
        <NSpace vertical style="width: 100%">
          <NSelect
            :value="draft.models"
            :options="modelOptions"
            multiple
            filterable
            tag
            :placeholder="t('providers.modelsPlaceholder')"
            @update:value="setModels"
          />
          <NButton size="small" :loading="fetching" :disabled="!draft.type" @click="fetchModels">{{ t('providers.fetchModels') }}</NButton>
        </NSpace>
      </NFormItem>
      <NFormItem :label="t('providers.defaultModel')">
        <NSelect v-model:value="draft.defaultModel" :options="modelOptions" :disabled="!draft.models.length" />
      </NFormItem>
    </NForm>
  </div>
</template>
