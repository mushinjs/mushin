<script setup lang="ts">
import { NAlert, NButton, NCheckbox, NCheckboxGroup, NForm, NFormItem, NInput, NModal, NSelect, NSpace, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../api'
import { useDataStore } from '../stores/data'
import type { Bot, CatalogEntry } from '../types'
import { localize } from '../utils'
import SchemaForm from './SchemaForm.vue'

const show = defineModel<boolean>('show', { required: true })
const emit = defineEmits<{ created: [bot: Bot] }>()

const { t, locale } = useI18n()
const data = useDataStore()
const message = useMessage()

const name = ref('')
const adapterType = ref('onebot')
const config = ref<Record<string, any>>({})
const plugins = ref<string[]>(['@mushin/bot-plugin-llm-chat'])
const catalog = ref<CatalogEntry[]>([])
const saving = ref(false)

watch(show, async (visible) => {
  if (!visible) return
  name.value = ''
  config.value = {}
  catalog.value = await call<CatalogEntry[]>('plugins.catalog', { kind: 'bot' }).catch(() => [])
  plugins.value = plugins.value.filter((item) => catalog.value.some((entry) => entry.package === item))
})

const adapter = computed(() => data.adapters.find((item) => item.id === adapterType.value))
const adapterOptions = computed(() => data.adapters.map((item) => ({ label: localize(item.displayName, locale.value), value: item.id })))
const mode = computed(() => config.value.mode ?? 'forward')
const hidden = computed(() => (mode.value === 'reverse' ? ['url'] : ['path']))

async function create() {
  saving.value = true
  try {
    const bot = await call<Bot>('bots.create', {
      name: name.value,
      adapter: { type: adapterType.value, config: config.value },
      plugins: plugins.value.map((item) => ({ package: item })),
    })
    show.value = false
    message.success(t('bots.created', { name: bot.name }))
    emit('created', bot)
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal v-model:show="show" preset="card" :title="t('bots.add')" style="width: min(600px, calc(100vw - 32px))">
    <NForm label-placement="top">
      <NFormItem :label="t('common.name')" required>
        <NInput v-model:value="name" :placeholder="t('bots.namePlaceholder')" />
      </NFormItem>
      <NFormItem :label="t('bots.adapter')" required>
        <NSelect v-model:value="adapterType" :options="adapterOptions" />
      </NFormItem>
    </NForm>

    <NAlert v-if="adapterType === 'onebot'" type="info" :show-icon="false" class="hint">
      {{ mode === 'reverse' ? t('bots.napcatReverse') : t('bots.napcatForward') }}
    </NAlert>

    <SchemaForm v-if="adapter" v-model="config" :schema="adapter.configSchema" :secrets="adapter.secrets" :hidden="hidden" />

    <NForm v-if="catalog.length" label-placement="top">
      <NFormItem :label="t('bots.initialPlugins')">
        <NCheckboxGroup v-model:value="plugins">
          <NSpace vertical>
            <NCheckbox v-for="entry in catalog" :key="entry.package" :value="entry.package">
              <strong>{{ localize(entry.manifest.displayName, locale) || entry.package }}</strong>
              <span class="desc"> — {{ localize(entry.manifest.description, locale) }}</span>
            </NCheckbox>
          </NSpace>
        </NCheckboxGroup>
      </NFormItem>
    </NForm>

    <template #footer>
      <NSpace justify="end">
        <NButton @click="show = false">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" :disabled="!name.trim()" @click="create">{{ t('common.create') }}</NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.hint {
  margin-bottom: 16px;
  white-space: pre-line;
}

.desc {
  opacity: 0.65;
}
</style>
