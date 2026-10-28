<script setup lang="ts">
import { NAutoComplete, NFormItem, NGrid, NGridItem, NSelect } from 'naive-ui'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../../api'
import { useDataStore } from '../../stores/data'

/** The embedding provider and model of a knowledge base; no provider means keyword search only. */
const provider = defineModel<string>('provider', { required: true })
const model = defineModel<string>('model', { required: true })

const { t } = useI18n()
const data = useDataStore()
const choices = ref<{ value: string; label: string }[]>([])

onMounted(async () => {
  try {
    choices.value = await call('providers.embedChoices')
  } catch {}
})

const providerOptions = computed(() => [{ value: '', label: t('knowledge.noEmbedding') }, ...choices.value])
// Saved model lists rarely include embedding models, so these are suggestions only.
const modelOptions = computed(() => {
  const saved = data.providers.find((item) => item.id === provider.value)?.models ?? []
  const embedding = saved.filter((name) => /embed|bge|m3e|gte/i.test(name))
  const known = ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-v3', 'bge-m3', 'nomic-embed-text', 'demo-embedding']
  return [...new Set([...embedding, ...known])].filter((name) => name.includes(model.value)).map((name) => ({ label: name, value: name }))
})
</script>

<template>
  <NGrid cols="1 500:2" responsive="self" :x-gap="12">
    <NGridItem>
      <NFormItem :label="t('knowledge.embeddingProvider')" :feedback="provider ? '' : t('knowledge.noEmbeddingHint')">
        <NSelect v-model:value="provider" :options="providerOptions" />
      </NFormItem>
    </NGridItem>
    <NGridItem>
      <NFormItem :label="t('knowledge.embeddingModel')" :feedback="provider ? t('knowledge.embeddingModelHint') : ''">
        <NAutoComplete v-model:value="model" :options="modelOptions" :disabled="!provider" placeholder="text-embedding-3-small" clearable />
      </NFormItem>
    </NGridItem>
  </NGrid>
</template>
