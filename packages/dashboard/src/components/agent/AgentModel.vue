<script setup lang="ts">
import { Alert, Button, Card, Form, FormItem, NumberInput, Progress, Select, useToast } from '@mushinjs/ui'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../../api'
import { providerOptions as toProviderOptions } from '../../models'
import { useDataStore } from '../../stores/data'
import ModelSelect from '../ModelSelect.vue'

interface AgentConfig {
  provider?: string
  model?: string
  maxSteps?: number
  confirmTimeout?: number
  dailyTokens?: number
}

const { t } = useI18n()
const message = useToast()
const data = useDataStore()

const entryId = ref<string>()
const config = ref<AgentConfig>({})
const usage = ref<{ input: number; output: number; budget: number }>()
const saving = ref(false)

async function load() {
  const plugins = await call<{ id: string; package: string; config: AgentConfig }[]>('plugins.list')
  const entry = plugins.find((plugin) => plugin.package === '@mushinjs/plugin-agent')
  entryId.value = entry?.id
  config.value = { maxSteps: 20, confirmTimeout: 600, dailyTokens: 0, ...entry?.config }
  usage.value = await call('agent.usage').catch(() => undefined)
}

onMounted(() => load().catch((error) => message.error(error.message)))

const providerOptions = computed(() => toProviderOptions(data.providers, data.profiles, t, { markDefault: true }))

const used = computed(() => (usage.value ? usage.value.input + usage.value.output : 0))
const percent = computed(() => (usage.value?.budget ? Math.min(100, Math.round((used.value / usage.value.budget) * 100)) : 0))

async function save() {
  if (!entryId.value) return
  saving.value = true
  try {
    const next = { ...config.value, provider: config.value.provider || undefined, model: config.value.model || undefined }
    await call('plugins.configure', { id: entryId.value, config: next })
    message.success(t('common.saved'))
    await load()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="model">
    <Card :title="t('agentPage.model.title')">
      <Form>
        <div class="row">
          <FormItem :label="t('agentPage.model.provider')">
            <Select v-model:value="config.provider" clearable :options="providerOptions" :placeholder="t('agentPalette.defaultProvider')" />
          </FormItem>
          <FormItem :label="t('agentPage.model.model')">
            <ModelSelect :model-value="config.model" :provider="config.provider" :placeholder="t('agentPalette.defaultModel')" @update:model-value="(value) => (config.model = value ?? undefined)" />
          </FormItem>
        </div>
        <div class="row">
          <FormItem :label="t('agentPage.model.maxSteps')" :feedback="t('agentPage.model.maxStepsHelp')">
            <NumberInput v-model:value="config.maxSteps" :min="1" :max="50" />
          </FormItem>
          <FormItem :label="t('agentPage.model.confirmTimeout')" :feedback="t('agentPage.model.confirmTimeoutHelp')">
            <NumberInput v-model:value="config.confirmTimeout" :min="10" />
          </FormItem>
        </div>
        <FormItem :label="t('agentPage.model.dailyTokens')" :feedback="t('agentPage.model.dailyTokensHelp')">
          <NumberInput v-model:value="config.dailyTokens" :min="0" :step="10000" />
        </FormItem>
      </Form>
      <template #action>
        <div class="flex flex-wrap gap-x-3 gap-y-2 items-center justify-between">
          <span class="hint small">{{ t('agentPage.model.restartNote') }}</span>
          <Button type="primary" :loading="saving" :disabled="!entryId" @click="save">{{ t('common.save') }}</Button>
        </div>
      </template>
    </Card>

    <Card v-if="usage" :title="t('agentPage.model.usageTitle')">
      <p class="usage">{{ t('agentPage.model.usage', { input: usage.input.toLocaleString(), output: usage.output.toLocaleString() }) }}</p>
      <template v-if="usage.budget">
        <Progress :percentage="percent" :status="percent >= 100 ? 'error' : percent >= 80 ? 'warning' : 'success'">{{ Math.round(percent) }}%</Progress>
        <p class="hint small">{{ t('agentPage.model.budget', { used: used.toLocaleString(), budget: usage.budget.toLocaleString() }) }}</p>
        <Alert v-if="percent >= 100" type="error" :show-icon="false">{{ t('agentPage.model.exhausted') }}</Alert>
      </template>
      <p v-else class="hint small">{{ t('agentPage.model.noBudget') }}</p>
    </Card>
  </div>
</template>

<style scoped>
.model {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 760px;
}

.row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.hint {
  opacity: 0.65;
}

.small {
  font-size: 12px;
}

.usage {
  margin: 0 0 8px;
}

@media (max-width: 700px) {
  .row {
    grid-template-columns: 1fr;
  }
}
</style>
