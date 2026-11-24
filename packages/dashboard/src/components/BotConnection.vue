<script setup lang="ts">
import { Alert, Button, Card, Form, FormItem, Input, Select, useToast } from '@mushinjs/ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../api'
import { providerOptions as toProviderOptions } from '../models'
import { useDataStore } from '../stores/data'
import type { Bot } from '../types'
import { adapterMode, guideKey, hiddenFields, isInbound } from '../adapters'
import { clone } from '../utils'
import AdapterLinks from './AdapterLinks.vue'
import QrCode from './QrCode.vue'
import SchemaForm from './SchemaForm.vue'
import SaveBar from './SaveBar.vue'

const props = defineProps<{ bot: Bot }>()
const { t, te } = useI18n()
const data = useDataStore()
const message = useToast()

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
const mode = computed(() => adapterMode(adapter.value, config.value))
const hidden = computed(() => hiddenFields(adapter.value, config.value))
const guide = computed(() => (te(guideKey(props.bot.adapter.type, mode.value)) ? t(guideKey(props.bot.adapter.type, mode.value)) : ''))
// Where the platform reaches Mushin: a WebSocket address for reverse mode, else an HTTP one.
const inboundUrl = computed(() => {
  if (!isInbound(mode.value)) return ''
  const base = serverUrl.value || location.origin
  const url = `${base}${config.value.path || `/${props.bot.adapter.type}/${props.bot.id}`}`
  return mode.value === 'reverse' ? url.replace(/^http/, 'ws') : url
})
const inviteHint = computed(() => (te(`bots.invite.${props.bot.adapter.type}`) ? t(`bots.invite.${props.bot.adapter.type}`) : t('bots.invite.default')))
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
  <Card>
    <div class="flex flex-col gap-[18px]">
      <Form>
        <FormItem :label="t('common.name')">
          <Input v-model:value="name" />
        </FormItem>
      </Form>

      <Alert v-if="guide || inboundUrl" type="info" :show-icon="false" class="hint">
        {{ guide }}
        <div v-if="inboundUrl" class="url mono">{{ inboundUrl }}</div>
      </Alert>
      <AdapterLinks :adapter="adapter" />

      <div v-if="bot.invite" class="invite">
        <QrCode :text="bot.invite" :size="132" />
        <div class="invite-side">
          <strong>{{ t('bots.invite.title') }}</strong>
          <span class="muted">{{ inviteHint }}</span>
          <a :href="bot.invite" target="_blank" rel="noopener"><Button size="small" type="primary" secondary>{{ t('bots.invite.open') }}</Button></a>
        </div>
      </div>

      <SchemaForm v-if="adapter" v-model="config" :schema="adapter.configSchema" :secrets="adapter.secrets" :hidden="hidden" />

      <Form>
        <FormItem :label="t('bot.defaultProvider')" :feedback="t('bot.defaultProviderHint')">
          <Select v-model:value="provider" :options="providerOptions" clearable :placeholder="t('bot.useGlobalDefault')" />
        </FormItem>
      </Form>
    </div>
  </Card>

  <SaveBar :show="dirty" :saving="saving" :text="t('bot.unsaved')" :discard-text="t('bot.discard')" :save-text="t('bot.saveAndRestart')" @discard="reset" @save="save" />
</template>

<style scoped>
.hint {
  white-space: pre-line;
}

.invite {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
}

.invite-side {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
  flex: 1;
  min-width: 180px;
}

.muted {
  opacity: 0.65;
  font-size: 13px;
}

.url {
  margin-top: 6px;
  font-size: 13px;
  user-select: all;
}
</style>
