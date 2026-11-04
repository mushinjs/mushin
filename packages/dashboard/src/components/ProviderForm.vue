<script setup lang="ts">
import { useToast } from '@mushin/ui'
import { NButton, NForm, NFormItem, NInput, NSelect, NSpace, NTag, type SelectOption } from 'naive-ui'
import { computed, h, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../api'
import type { ProviderDraft, ProviderType } from '../types'
import { modelOptions as toOptions, renderModel, renderModelOption } from '../models'
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

const presetOptions = computed(() => props.types.flatMap((item) => item.presets.map((preset) => ({
  label: localize(preset.label, locale.value),
  value: `${item.id}:${preset.id}`,
}))))

const typeOptions = computed(() => props.types.map((item) => ({ label: localize(item.displayName, locale.value), value: item.id })))

const modelOptions = computed(() => toOptions([...new Set([...draft.value.models, ...fetched.value])]))

const renderModelTag = ({ option, handleClose }: { option: SelectOption; handleClose: () => void }) =>
  h(NTag, { size: 'small', closable: true, onClose: (event: MouseEvent) => { event.stopPropagation(); handleClose() } }, () => renderModel(String(option.value)))

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
            :render-label="renderModelOption"
            :render-tag="renderModelTag"
            @update:value="setModels"
          />
          <NSpace :size="8">
            <NButton size="small" :loading="fetching" :disabled="!draft.type" @click="fetchModels">{{ t('providers.fetchModels') }}</NButton>
            <NButton size="small" :disabled="!draft.models.length" @click="clearModels">{{ t('providers.clearModels') }}</NButton>
          </NSpace>
        </NSpace>
      </NFormItem>
      <NFormItem :label="t('providers.defaultModel')" :feedback="t('providers.defaultModelHint')">
        <NSelect
          :value="draft.defaultModel || null"
          :options="modelOptions"
          :render-label="renderModelOption"
          filterable
          tag
          clearable
          :placeholder="t('profiles.typeOrPick')"
          @update:value="(value: string | null) => (draft = { ...draft, defaultModel: value ?? '' })"
        />
      </NFormItem>
    </NForm>
  </div>
</template>
