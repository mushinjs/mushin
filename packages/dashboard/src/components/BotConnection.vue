<script setup lang="ts">
import { NAlert, NCard, NForm, NFormItem, NInput, NSelect, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../api'
import { providerOptions as toProviderOptions } from '../models'
import { useDataStore } from '../stores/data'
import type { Bot } from '../types'
import { clone } from '../utils'
import SchemaForm from './SchemaForm.vue'
import SaveBar from './SaveBar.vue'

const props = defineProps<{ bot: Bot }>()
const { t } = useI18n()
const data = useDataStore()
const message = useMessage()

const name = ref('')
const config = ref<Record<string, any>>({})
const provider = ref<string | null>(null)
const saving = ref(false)
const serverUrl = ref('')

call<{ baseUrl: string }>('system.info').then((info) => (serverUrl.value = info.baseUrl)).catch(() => {})

function reset() {
  name.value = props.bot.name
  config.value = clone(props.bot.adapter.config)
  provider.value = props.bot.provider ?? null
  saved.value = snapshot()
}

// What was last loaded or saved, to tell whether the form has changes worth a save bar.
const snapshot = () => JSON.stringify({ name: name.value, config: config.value, provider: provider.value })
const saved = ref('')
const dirty = computed(() => snapshot() !== saved.value)

watch(() => props.bot.id, reset, { immediate: true })

const adapter = computed(() => data.adapters.find((item) => item.id === props.bot.adapter.type))
const mode = computed(() => config.value.mode ?? 'forward')
// Fields each connection mode does not use.
const hidden = computed(() => (mode.value === 'reverse' ? ['url', 'secret'] : mode.value === 'http' ? [] : ['path', 'secret']))
const reverseUrl = computed(() => {
  const base = (serverUrl.value || location.origin).replace(/^http/, 'ws')
  return `${base}${config.value.path || `/onebot/${props.bot.id}`}`
})
const providerOptions = computed(() => toProviderOptions(data.providers, data.profiles, t))

async function save() {
  saving.value = true
  try {
    await call('bots.update', {
      id: props.bot.id,
      name: name.value,
      adapter: { type: props.bot.adapter.type, config: config.value },
      provider: provider.value,
    })
    saved.value = snapshot()
    message.success(t('common.saved'))
    await data.refreshBots()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NCard>
    <NForm label-placement="top">
      <NFormItem :label="t('common.name')">
        <NInput v-model:value="name" />
      </NFormItem>
    </NForm>

    <NAlert v-if="bot.adapter.type === 'onebot'" type="info" :show-icon="false" class="hint">
      <template v-if="mode === 'reverse'">
        {{ t('bots.napcatReverse') }}
        <div class="url mono">{{ reverseUrl }}</div>
      </template>
      <template v-else-if="mode === 'http'">
        {{ t('bots.napcatHttp') }}
        <div class="url mono">{{ reverseUrl.replace(/^ws/, 'http') }}</div>
      </template>
      <template v-else>{{ t('bots.napcatForward') }}</template>
    </NAlert>

    <SchemaForm v-if="adapter" v-model="config" :schema="adapter.configSchema" :secrets="adapter.secrets" :hidden="hidden" />

    <NForm label-placement="top">
      <NFormItem :label="t('bot.defaultProvider')" :feedback="t('bot.defaultProviderHint')">
        <NSelect v-model:value="provider" :options="providerOptions" clearable :placeholder="t('bot.useGlobalDefault')" />
      </NFormItem>
    </NForm>

  </NCard>

  <SaveBar :show="dirty" :saving="saving" :text="t('bot.unsaved')" :discard-text="t('bot.discard')" :save-text="t('bot.saveAndRestart')" @discard="reset" @save="save" />
</template>

<style scoped>
.hint {
  margin-bottom: 16px;
  white-space: pre-line;
}

.url {
  margin-top: 6px;
  font-size: 13px;
  user-select: all;
}
</style>
