<script setup lang="ts">
import { Button, Form, FormItem, Input, Select, type SelectGroup, Tag } from '@mushinjs/ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDataStore } from '../stores/data'
import type { ProfileModel } from '../types'
import IconAction from './IconAction.vue'
import ModelCaps from './ModelCaps.vue'
import ModelSelect from './ModelSelect.vue'

export interface ProfileDraft {
  name: string
  models: ProfileModel[]
}

/** A profile's name and its models in order: the first answers, the rest are fallbacks. */
const draft = defineModel<ProfileDraft>({ required: true })
const { t } = useI18n()
const data = useDataStore()

const SEP = '\u0000'
const keyOf = (item: ProfileModel) => `${item.provider}${SEP}${item.model}`

/** Every listed model of every provider, grouped by provider, for picking several at once. */
const listed = computed<SelectGroup[]>(() => data.providers.filter((provider) => provider.models.length).map((provider) => ({
  type: 'group' as const,
  key: provider.id,
  label: provider.name,
  children: provider.models.map((model) => ({ label: model, value: keyOf({ provider: provider.id, model }) })),
})))

// Models typed by hand are not in the list, so only listed ones count as picked.
const picked = computed(() => draft.value.models.filter(isListed).map(keyOf))

/** Keeps the order of models already chosen and adds newly picked ones at the end. */
function setPicked(keys: string[]) {
  const kept = draft.value.models.filter((item) => keys.includes(keyOf(item)) || !isListed(item))
  const added = keys.filter((key) => !draft.value.models.some((item) => keyOf(item) === key)).map((key) => {
    const [provider, model] = key.split(SEP)
    return { provider, model }
  })
  draft.value = { ...draft.value, models: [...kept, ...added] }
}

const isListed = (item: ProfileModel) => !!data.providers.find((provider) => provider.id === item.provider)?.models.includes(item.model)

function move(index: number, by: number) {
  const models = [...draft.value.models]
  const [item] = models.splice(index, 1)
  models.splice(index + by, 0, item)
  draft.value = { ...draft.value, models }
}

function remove(index: number) {
  draft.value = { ...draft.value, models: draft.value.models.filter((_, position) => position !== index) }
}

// A model typed by hand, for names the provider does not list.
const manual = ref<{ provider: string | null; model: string | null }>({ provider: data.providers.find((item) => item.isDefault)?.id ?? null, model: null })
const providerOnly = computed(() => data.providers.map((provider) => ({ label: provider.name, value: provider.id })))

function addManual() {
  const model = manual.value.model?.trim()
  if (!manual.value.provider || !model) return
  const item = { provider: manual.value.provider, model }
  if (!draft.value.models.some((entry) => keyOf(entry) === keyOf(item))) draft.value = { ...draft.value, models: [...draft.value.models, item] }
  manual.value.model = null
}

const providerName = (id: string) => data.providers.find((provider) => provider.id === id)?.name ?? id
</script>

<template>
  <Form>
    <FormItem :label="t('common.name')" required>
      <Input v-model:value="draft.name" :placeholder="t('profiles.namePlaceholder')" />
    </FormItem>
    <FormItem :label="t('profiles.pick')" :feedback="t('profiles.pickHint')">
      <Select
        :value="picked"
        :options="listed"
        multiple
        filterable
        :max-tag-count="0"
        :placeholder="t('profiles.pickPlaceholder')"
        @update:value="setPicked"
      >
        <template #option="{ option }">
          <span class="model-label"><span class="model-label-name">{{ option.label }}</span><ModelCaps :model="option.label" /></span>
        </template>
      </Select>
    </FormItem>
    <FormItem :label="t('profiles.manual')">
      <div class="manual">
        <Select v-model:value="manual.provider" :options="providerOnly" class="manual-provider" />
        <ModelSelect v-model="manual.model" :provider="manual.provider" class="manual-model" />
        <Button :disabled="!manual.provider || !manual.model?.trim()" @click="addManual">{{ t('common.add') }}</Button>
      </div>
    </FormItem>
    <FormItem :label="t('profiles.order')" :feedback="t('profiles.orderHint')" required>
      <div v-if="draft.models.length" class="order">
        <div v-for="(item, index) in draft.models" :key="keyOf(item)" class="order-row">
          <Tag size="small" :type="index === 0 ? 'primary' : 'default'" class="order-tag">
            {{ index === 0 ? t('profiles.primary') : t('profiles.fallback', { n: index }) }}
          </Tag>
          <span class="order-provider">{{ providerName(item.provider) }}</span>
          <span class="order-model">
            <span class="mono">{{ item.model }}</span>
            <ModelCaps :model="item.model" />
          </span>
          <span class="order-actions">
            <IconAction icon="i-lucide-arrow-up" :label="t('profiles.moveUp')" :disabled="index === 0" @click="move(index, -1)" />
            <IconAction icon="i-lucide-arrow-down" :label="t('profiles.moveDown')" :disabled="index === draft.models.length - 1" @click="move(index, 1)" />
            <IconAction icon="i-lucide-trash-2" :label="t('common.remove')" type="error" @click="remove(index)" />
          </span>
        </div>
      </div>
      <span v-else class="empty">{{ t('profiles.noModels') }}</span>
    </FormItem>
  </Form>
</template>

<style scoped>
.manual {
  display: flex;
  gap: 8px;
  width: 100%;
}

.manual-provider {
  flex: 0 0 34%;
}

.manual-model {
  flex: 1;
  min-width: 0;
}

.order {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.order-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 4px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
}

.order-tag {
  flex: 0 0 auto;
}

.order-provider {
  flex: 0 0 auto;
  color: var(--fg2);
  font-size: 13px;
}

.order-model {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.order-actions {
  display: flex;
  flex: 0 0 auto;
}

.empty {
  color: var(--fg3);
}
</style>
