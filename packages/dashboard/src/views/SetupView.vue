<script setup lang="ts">
import { CheckmarkCircle } from '@vicons/ionicons5'
import { NAlert, NButton, NCard, NIcon, NSpace, NStep, NSteps, useMessage } from 'naive-ui'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call } from '../api'
import ProviderForm from '../components/ProviderForm.vue'
import { useAgentStore } from '../stores/agent'
import { useDataStore } from '../stores/data'
import type { Provider, ProviderDraft, ProviderTest } from '../types'

const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const data = useDataStore()
const agent = useAgentStore()

const draft = ref<ProviderDraft>({ name: '', type: 'openai', config: {}, models: [] })
const saving = ref(false)
const error = ref('')
const savedId = ref<string>()

onMounted(() => data.refreshProviders().catch(() => {}))

const step = computed(() => (data.ready ? 2 : 1))

async function save() {
  saving.value = true
  error.value = ''
  try {
    const input = { ...draft.value, isDefault: true }
    const provider = savedId.value
      ? await call<Provider>('providers.update', { id: savedId.value, ...input })
      : await call<Provider>('providers.create', input)
    savedId.value = provider.id
    const test = await call<ProviderTest>('providers.test', { id: provider.id })
    if (!test.ok) {
      error.value = t('setup.testFailed', { error: test.error })
      return
    }
    message.success(t('setup.ready', { latency: test.latencyMs }))
    await data.refreshProviders()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

function startAgent() {
  agent.open = true
  router.push('/bots')
}
</script>

<template>
  <div class="page setup">
    <div class="page-header">
      <div>
        <h1>{{ t('setup.title') }}</h1>
        <p class="page-lead">{{ t('setup.lead') }}</p>
      </div>
    </div>

    <NSteps :current="step" class="steps">
      <NStep :title="t('setup.step1')" />
      <NStep :title="t('setup.step2')" />
    </NSteps>

    <NCard v-if="!data.ready" :title="t('setup.providerTitle')">
      <ProviderForm v-if="data.providerTypes.length" v-model="draft" :types="data.providerTypes" :provider-id="savedId" />
      <NAlert v-if="error" type="error" :show-icon="true" style="margin-bottom: 16px">{{ error }}</NAlert>
      <NButton type="primary" :loading="saving" :disabled="!draft.name || !draft.models.length" @click="save">
        {{ t('setup.testAndSave') }}
      </NButton>
    </NCard>

    <NCard v-else>
      <NSpace vertical align="center" class="done">
        <NIcon size="48" color="#18a058"><CheckmarkCircle /></NIcon>
        <h2>{{ t('setup.doneTitle') }}</h2>
        <p>{{ t('setup.doneLead') }}</p>
        <NSpace>
          <NButton type="primary" @click="startAgent">{{ t('setup.talkToAgent') }}</NButton>
          <NButton @click="router.push('/bots')">{{ t('setup.goBots') }}</NButton>
        </NSpace>
      </NSpace>
    </NCard>
  </div>
</template>

<style scoped>
.setup {
  max-width: 720px;
}

.steps {
  margin-bottom: 20px;
}

.done {
  text-align: center;
  padding: 16px 0;
}

.done h2 {
  margin: 0;
}

.done p {
  margin: 0 0 8px;
  opacity: 0.7;
}
</style>
