<script setup lang="ts">
import { Alert, Button, Card, useToast } from '@mushinjs/ui'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call } from '../api'
import PageHeader from '../components/PageHeader.vue'
import ProviderForm from '../components/ProviderForm.vue'
import { useAgentStore } from '../stores/agent'
import { useDataStore } from '../stores/data'
import type { Provider, ProviderDraft, ProviderTest } from '../types'

const { t } = useI18n()
const router = useRouter()
const message = useToast()
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
    <PageHeader :title="t('setup.title')" :lead="t('setup.lead')" />

    <ol class="steps">
      <li
        v-for="(title, index) in [t('setup.step1'), t('setup.step2')]"
        :key="index"
        :class="{ 'is-done': index + 1 < step, 'is-current': index + 1 === step }"
        :aria-current="index + 1 === step ? 'step' : undefined"
      >
        <span class="step-mark"><span v-if="index + 1 < step" class="i-lucide-check" /><template v-else>{{ index + 1 }}</template></span>
        <span>{{ title }}</span>
      </li>
    </ol>

    <Card v-if="!data.ready" :title="t('setup.providerTitle')">
      <ProviderForm v-if="data.providerTypes.length" v-model="draft" :types="data.providerTypes" :provider-id="savedId" />
      <Alert v-if="error" type="error" class="error">{{ error }}</Alert>
      <Button type="primary" :loading="saving" :disabled="!draft.name || !draft.models.length" @click="save">
        {{ t('setup.testAndSave') }}
      </Button>
    </Card>

    <Card v-else>
      <div class="done">
        <span class="i-lucide-circle-check done-icon" />
        <h2>{{ t('setup.doneTitle') }}</h2>
        <p>{{ t('setup.doneLead') }}</p>
        <div class="done-actions">
          <Button type="primary" @click="startAgent">{{ t('setup.talkToAgent') }}</Button>
          <Button @click="router.push('/bots')">{{ t('setup.goBots') }}</Button>
        </div>
      </div>
    </Card>
  </div>
</template>

<style scoped>
.setup {
  max-width: 720px;
}

.steps {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 20px;
  padding: 0;
  list-style: none;
}

.steps li {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 10px;
  color: var(--fg3);
  font-size: 14px;
}

.steps li:last-child {
  flex: none;
}

/* A line after every step but the last, as the path to the next one. */
.steps li:not(:last-child)::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line);
}

.step-mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 26px;
  box-sizing: border-box;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  font-size: 13px;
  font-weight: 600;
}

.steps li.is-current {
  color: var(--fg);
  font-weight: 500;
}

.steps li.is-current .step-mark {
  border-color: var(--primary);
  background: var(--primary);
  color: var(--primary-fg);
}

.steps li.is-done {
  color: var(--fg2);
}

.steps li.is-done .step-mark {
  border-color: var(--primary);
  color: var(--primary);
}

.error {
  margin-bottom: 16px;
}

.done {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
  text-align: center;
}

.done-icon {
  font-size: 48px;
  color: var(--ok);
}

.done-actions {
  display: flex;
  gap: 8px;
}

.done h2 {
  margin: 0;
}

.done p {
  margin: 0 0 8px;
  opacity: 0.7;
}
</style>
