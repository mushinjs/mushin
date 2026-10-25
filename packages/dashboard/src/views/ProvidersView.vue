<script setup lang="ts">
import { CreateOutline, FlashOutline, Star, StarOutline, TrashOutline } from '@vicons/ionicons5'
import IconAction from '../components/IconAction.vue'
import { AddOutline } from '@vicons/ionicons5'
import {
  type DataTableColumns, NButton, NCard, NDataTable, NEmpty, NIcon, NModal, NSpace, NTag, NTooltip, useDialog, useMessage,
} from 'naive-ui'
import { computed, h, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../api'
import ProviderForm from '../components/ProviderForm.vue'
import { useDataStore } from '../stores/data'
import type { Provider, ProviderDraft, ProviderTest } from '../types'
import { clone, localize } from '../utils'

const { t, locale } = useI18n()
const data = useDataStore()
const message = useMessage()
const dialog = useDialog()

const editing = ref<string | null>(null)
const showEditor = ref(false)
const draft = ref<ProviderDraft>({ name: '', type: 'openai', config: {}, models: [] })
const saving = ref(false)
const testing = ref<string>()

onMounted(() => data.refreshProviders().catch((error) => message.error(error.message)))

function openCreate() {
  editing.value = null
  draft.value = { name: '', type: data.providerTypes[0]?.id ?? 'openai', config: {}, models: [] }
  showEditor.value = true
}

function openEdit(provider: Provider) {
  editing.value = provider.id
  draft.value = { name: provider.name, type: provider.type, config: clone(provider.config), models: [...provider.models], defaultModel: provider.defaultModel }
  showEditor.value = true
}

async function save() {
  saving.value = true
  try {
    if (editing.value) await call('providers.update', { id: editing.value, ...draft.value })
    else await call('providers.create', draft.value)
    showEditor.value = false
    message.success(t('common.saved'))
    await data.refreshProviders()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

async function test(provider: Provider) {
  testing.value = provider.id
  try {
    const result = await call<ProviderTest>('providers.test', { id: provider.id })
    if (result.ok) message.success(t('providers.testOk', { latency: result.latencyMs }))
    else message.error(t('providers.testFailed', { error: result.error }))
    await data.refreshProviders()
  } finally {
    testing.value = undefined
  }
}

async function setDefault(provider: Provider) {
  await call('providers.setDefault', { id: provider.id })
  await data.refreshProviders()
}

function remove(provider: Provider) {
  dialog.warning({
    title: t('common.confirmDelete', { name: provider.name }),
    content: t('providers.deleteHint'),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await call('providers.delete', { id: provider.id })
      message.success(t('common.deleted'))
      await data.refreshProviders()
    },
  })
}

const typeName = (id: string) => localize(data.providerTypes.find((type) => type.id === id)?.displayName, locale.value) || id

const columns = computed<DataTableColumns<Provider>>(() => [
  {
    title: t('common.name'),
    key: 'name',
    render: (row) => h(NSpace, { size: 6, align: 'center' }, () => [
      h('strong', row.name),
      row.isDefault ? h(NTag, { size: 'small', type: 'primary', bordered: false }, () => t('common.default')) : null,
      !row.typeAvailable ? h(NTag, { size: 'small', type: 'warning', bordered: false }, () => t('providers.typeMissing')) : null,
    ]),
  },
  { title: t('common.type'), key: 'type', width: 170, render: (row) => typeName(row.type) },
  { title: t('providers.defaultModel'), key: 'defaultModel', width: 170, ellipsis: { tooltip: true }, render: (row) => h('span', { class: 'mono' }, row.defaultModel ?? '-') },
  {
    title: t('providers.lastTest'),
    key: 'lastTest',
    width: 110,
    render: (row) => {
      if (!row.lastTest) return h('span', { style: 'opacity: .5' }, t('providers.untested'))
      if (row.lastTest.ok) return h(NTag, { size: 'small', type: 'success', bordered: false }, () => `${row.lastTest!.latencyMs} ms`)
      return h(NTooltip, null, {
        trigger: () => h(NTag, { size: 'small', type: 'error', bordered: false }, () => t('status.failed')),
        default: () => row.lastTest!.error,
      })
    },
  },
  {
    title: t('common.actions'),
    key: 'actions',
    align: 'right',
    fixed: 'right',
    width: 150,
    render: (row) => h(NSpace, { size: 2, justify: 'end', wrap: false }, () => [
      h(IconAction, { icon: FlashOutline, label: t('common.test'), type: 'primary', loading: testing.value === row.id, onClick: () => test(row) }),
      h(IconAction, { icon: row.isDefault ? Star : StarOutline, label: row.isDefault ? t('common.default') : t('providers.makeDefault'), disabled: row.isDefault, onClick: () => setDefault(row) }),
      h(IconAction, { icon: CreateOutline, label: t('common.edit'), onClick: () => openEdit(row) }),
      h(IconAction, { icon: TrashOutline, label: t('common.delete'), type: 'error', onClick: () => remove(row) }),
    ]),
  },
])
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>{{ t('nav.providers') }}</h1>
        <p class="page-lead">{{ t('providers.lead') }}</p>
      </div>
      <NButton type="primary" data-agent-target="providers.add" @click="openCreate">
        <template #icon><NIcon><AddOutline /></NIcon></template>
        {{ t('providers.add') }}
      </NButton>
    </div>

    <NCard>
      <NDataTable v-if="data.providers.length" :columns="columns" :data="data.providers" :row-key="(row: Provider) => row.id" :scroll-x="900" />
      <NEmpty v-else :description="t('providers.empty')">
        <template #extra>
          <NButton type="primary" @click="openCreate">{{ t('providers.add') }}</NButton>
        </template>
      </NEmpty>
    </NCard>

    <NModal v-model:show="showEditor" preset="card" :title="editing ? t('providers.edit') : t('providers.add')" style="width: min(600px, calc(100vw - 32px))">
      <ProviderForm v-model="draft" :types="data.providerTypes" :provider-id="editing ?? undefined" />
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showEditor = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" :disabled="!draft.name" @click="save">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>
