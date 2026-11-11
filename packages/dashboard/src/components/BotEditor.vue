<script setup lang="ts">
import { Alert, Button, Checkbox, Form, FormItem, Input, Modal, Select, useToast } from '@mushinjs/ui'
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
const message = useToast()

const name = ref('')
const adapterType = ref('onebot')
const config = ref<Record<string, any>>({})
const plugins = ref<string[]>(['@mushinjs/bot-plugin-llm-chat'])
const catalog = ref<CatalogEntry[]>([])
const togglePlugin = (name: string, on: boolean) => (plugins.value = on ? [...plugins.value, name] : plugins.value.filter((item) => item !== name))
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
// Fields each connection mode does not use.
const hidden = computed(() => (mode.value === 'reverse' ? ['url', 'secret'] : mode.value === 'http' ? [] : ['path', 'secret']))

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
  <Modal v-model:show="show" :title="t('bots.add')" :width="600">
    <div class="editor">
      <Form>
        <FormItem :label="t('common.name')" required>
          <Input v-model:value="name" :placeholder="t('bots.namePlaceholder')" />
        </FormItem>
        <FormItem :label="t('bots.adapter')" required>
          <Select v-model:value="adapterType" :options="adapterOptions" />
        </FormItem>
      </Form>

      <Alert v-if="adapterType === 'onebot'" type="info" :show-icon="false" class="hint">
        {{ mode === 'reverse' ? t('bots.napcatReverse') : mode === 'http' ? t('bots.napcatHttp') : t('bots.napcatForward') }}
      </Alert>

      <SchemaForm v-if="adapter" v-model="config" :schema="adapter.configSchema" :secrets="adapter.secrets" :hidden="hidden" />

      <Form v-if="catalog.length">
        <FormItem :label="t('bots.initialPlugins')">
          <div class="plugins">
            <Checkbox v-for="entry in catalog" :key="entry.package" :checked="plugins.includes(entry.package)" @update:checked="(on) => togglePlugin(entry.package, on)">
              <strong>{{ localize(entry.manifest.displayName, locale) || entry.package }}</strong>
              <span class="desc"> — {{ localize(entry.manifest.description, locale) }}</span>
            </Checkbox>
          </div>
        </FormItem>
      </Form>
    </div>

    <template #footer>
      <Button @click="show = false">{{ t('common.cancel') }}</Button>
      <Button type="primary" :loading="saving" :disabled="!name.trim()" @click="create">{{ t('common.create') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.plugins {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.editor {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.hint {
  white-space: pre-line;
}

.desc {
  opacity: 0.65;
}
</style>
