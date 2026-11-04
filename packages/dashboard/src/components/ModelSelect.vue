<script setup lang="ts">
import { Select } from '@mushin/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { modelOptions } from '../models'
import ModelCaps from './ModelCaps.vue'
import { useDataStore } from '../stores/data'

/**
 * A model of a provider: pick a listed one or type any name. For a profile, which names its own
 * models, it shows the profile's order instead.
 */
const props = defineProps<{
  /** Provider or profile id; empty means the default provider. */
  provider?: string | null
  placeholder?: string
  size?: 'small' | 'medium'
}>()
const model = defineModel<string | null | undefined>()
const { t } = useI18n()
const data = useDataStore()

const profile = computed(() => data.profiles.find((item) => item.id === props.provider))
const options = computed(() => {
  const provider = data.providers.find((item) => item.id === props.provider) ?? (props.provider ? undefined : data.providers.find((item) => item.isDefault))
  return modelOptions(provider?.models ?? [])
})
const profileOrder = computed(() => profile.value?.models.map((item) => item.model).join(' → ') ?? '')
</script>

<template>
  <Select
    v-if="profile"
    :value="null"
    disabled
    :size="size"
    :placeholder="t('profiles.decidedBy', { order: profileOrder })"
  />
  <Select
    v-else
    v-model:value="model"
    :options="options"
    filterable
    tag
    clearable
    :size="size"
    :placeholder="placeholder ?? t('profiles.typeOrPick')"
  >
    <template #option="{ option }">
      <span class="model-label"><span class="model-label-name">{{ option.label }}</span><ModelCaps :model="String(option.value)" /></span>
    </template>
  </Select>
</template>
