<script setup lang="ts">
import { Button, Card, Form, FormItem, Input, NumberInput, Select, Toggle, useConfirm, useToast } from '@mushin/ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../../api'
import { useDataStore } from '../../stores/data'
import type { KnowledgeSummary } from '../../types'
import EmbeddingPicker from './EmbeddingPicker.vue'

const props = defineProps<{ base: KnowledgeSummary }>()
const emit = defineEmits<{ deleted: [] }>()
const { t } = useI18n()
const message = useToast()
const dialog = useConfirm()
const data = useDataStore()

const draftOf = (base: KnowledgeSummary) => ({
  name: base.name,
  description: base.description,
  provider: base.provider,
  model: base.model,
  chunkSize: base.chunkSize,
  chunkOverlap: base.chunkOverlap,
  topK: base.topK,
  minScore: base.minScore,
  bots: [...base.bots],
  commands: { ...base.commands },
})
const draft = ref(draftOf(props.base))
watch(() => props.base, (base) => {
  draft.value = draftOf(base)
})
const saving = ref(false)

const botOptions = computed(() => data.bots.map((bot) => ({ value: bot.id, label: bot.name })))
const roleOptions = computed(() => (['user', 'admin', 'master'] as const).map((role) => ({ value: role, label: t(`knowledge.settings.role.${role}`) })))

async function save() {
  if (!draft.value.name.trim()) {
    message.warning(t('knowledge.nameRequired'))
    return
  }
  if (draft.value.provider && !draft.value.model.trim()) {
    message.warning(t('knowledge.modelRequired'))
    return
  }
  const modelChanged = draft.value.provider !== props.base.provider || draft.value.model.trim() !== props.base.model
  const sizeChanged = draft.value.chunkSize !== props.base.chunkSize || draft.value.chunkOverlap !== props.base.chunkOverlap
  saving.value = true
  try {
    await call('kb.update', {
      id: props.base.id,
      ...draft.value,
      name: draft.value.name.trim(),
      model: draft.value.provider ? draft.value.model.trim() : '',
    })
    message.success(modelChanged && props.base.chunks ? t('knowledge.settings.reembedding') : t('common.saved'))
    if (sizeChanged && props.base.docs) message.info(t('knowledge.settings.sizeHint'))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

async function reindex() {
  try {
    await call('kb.reindex', { id: props.base.id })
    message.success(t('knowledge.settings.reembedding'))
  } catch (error) {
    message.error((error as Error).message)
  }
}

function remove() {
  dialog.warning({
    title: t('common.confirmDelete', { name: props.base.name }),
    content: t('knowledge.settings.deleteHint', { docs: props.base.docs, chunks: props.base.chunks }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await call('kb.delete', { id: props.base.id })
      message.success(t('common.deleted'))
      emit('deleted')
    },
  })
}
</script>

<template>
  <div class="settings">
    <Card size="small">
      <Form>
        <div class="grid gap-x-[16px] gap-y-[18px] grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
          <FormItem :label="t('common.name')" required>
            <Input v-model:value="draft.name" :maxlength="60" />
          </FormItem>
          <FormItem :label="t('knowledge.description')" :feedback="t('knowledge.descriptionHint')">
            <Input v-model:value="draft.description" :maxlength="500" />
          </FormItem>
        </div>
        <EmbeddingPicker v-model:provider="draft.provider" v-model:model="draft.model" />
        <div class="grid gap-x-[16px] gap-y-[18px] grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
          <FormItem :label="t('knowledge.settings.chunkSize')" :feedback="t('knowledge.settings.chunkSizeHint')">
            <NumberInput v-model:value="draft.chunkSize" :min="100" :max="4000" :step="50" style="width: 100%" />
          </FormItem>
          <FormItem :label="t('knowledge.settings.chunkOverlap')" :feedback="t('knowledge.settings.chunkOverlapHint')">
            <NumberInput v-model:value="draft.chunkOverlap" :min="0" :max="1000" :step="10" style="width: 100%" />
          </FormItem>
          <FormItem :label="t('knowledge.settings.topK')" :feedback="t('knowledge.settings.topKHint')">
            <NumberInput v-model:value="draft.topK" :min="1" :max="20" style="width: 100%" />
          </FormItem>
          <FormItem :label="t('knowledge.settings.minScore')" :feedback="t('knowledge.settings.minScoreHint')">
            <NumberInput v-model:value="draft.minScore" :min="0" :max="1" :step="0.05" style="width: 100%" />
          </FormItem>
        </div>
        <FormItem :label="t('knowledge.settings.bots')" :feedback="t('knowledge.settings.botsHint')">
          <Select v-model:value="draft.bots" :options="botOptions" multiple clearable />
        </FormItem>
        <div class="grid gap-x-[16px] gap-y-[18px] grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
          <FormItem :label="t('knowledge.settings.commands')" :feedback="t('knowledge.settings.commandsHint')">
            <Toggle v-model:value="draft.commands.enabled" />
          </FormItem>
          <FormItem :label="t('knowledge.settings.commandRole')">
            <Select v-model:value="draft.commands.role" :options="roleOptions" :disabled="!draft.commands.enabled" />
          </FormItem>
        </div>
      </Form>
      <div class="flex flex-wrap gap-x-3 gap-y-2 items-center justify-end">
        <Button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</Button>
      </div>
    </Card>

    <Card size="small" :title="t('knowledge.settings.maintenance')">
      <div class="flex flex-wrap gap-x-3 gap-y-2 items-center">
        <Button :disabled="!base.model || !base.chunks" @click="reindex">{{ t('knowledge.settings.reindex') }}</Button>
        <Button type="error" ghost @click="remove">{{ t('knowledge.settings.delete') }}</Button>
      </div>
    </Card>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
