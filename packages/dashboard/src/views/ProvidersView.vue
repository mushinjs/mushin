<script setup lang="ts">
import { CreateOutline, FlashOutline, Star, StarOutline, TrashOutline } from '@vicons/ionicons5'
import IconAction from '../components/IconAction.vue'
import { AddOutline, GitBranchOutline } from '@vicons/ionicons5'
import {
  type DataTableColumns, NButton, NCard, NDataTable, NEmpty, NIcon, NModal, NSpace, NTag, NTooltip, useDialog, useMessage,
} from 'naive-ui'
import { computed, h, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { call } from '../api'
import ModelCaps from '../components/ModelCaps.vue'
import ProfileForm, { type ProfileDraft } from '../components/ProfileForm.vue'
import ProviderForm from '../components/ProviderForm.vue'
import { profileModelLabel } from '../models'
import { useDataStore } from '../stores/data'
import type { ModelProfile, Provider, ProviderDraft, ProviderTest } from '../types'
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

/** /providers?highlight=<id> (e.g. from an id in the logs) scrolls to that provider or profile and makes it stand out. */
const route = useRoute()
const highlighted = ref<string>()
watch(() => [route.query.highlight, data.loadedProviders] as const, async ([target, loaded]) => {
  if (typeof target !== 'string' || !loaded) return
  highlighted.value = target
  await nextTick()
  document.getElementById(`provider-${target}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  window.setTimeout(() => (highlighted.value = undefined), 2500)
}, { immediate: true })
const rowProps = (row: { id: string }) => ({ id: `provider-${row.id}` })
const rowClass = (row: { id: string }) => (row.id === highlighted.value ? 'highlighted' : '')

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
    const body = { ...draft.value, defaultModel: draft.value.defaultModel?.trim() ?? '' }
    if (editing.value) await call('providers.update', { id: editing.value, ...body })
    else await call('providers.create', body)
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

// Profiles: a primary model with fallbacks, usable wherever a provider is chosen.
const editingProfile = ref<string | null>(null)
const showProfileEditor = ref(false)
const profileDraft = ref<ProfileDraft>({ name: '', models: [] })
const savingProfile = ref(false)

function openProfile(profile?: ModelProfile) {
  editingProfile.value = profile?.id ?? null
  profileDraft.value = profile ? { name: profile.name, models: profile.models.map((item) => ({ ...item })) } : { name: '', models: [] }
  showProfileEditor.value = true
}

async function saveProfile() {
  savingProfile.value = true
  try {
    if (editingProfile.value) await call('providers.updateProfile', { id: editingProfile.value, ...profileDraft.value })
    else await call('providers.createProfile', profileDraft.value)
    showProfileEditor.value = false
    message.success(t('common.saved'))
    await data.refreshProviders()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    savingProfile.value = false
  }
}

function removeProfile(profile: ModelProfile) {
  dialog.warning({
    title: t('common.confirmDelete', { name: profile.name }),
    content: t('profiles.deleteHint'),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await call('providers.deleteProfile', { id: profile.id })
      message.success(t('common.deleted'))
      await data.refreshProviders()
    },
  })
}

const profileColumns = computed<DataTableColumns<ModelProfile>>(() => [
  { title: t('common.name'), key: 'name', width: 180, render: (row) => h('strong', row.name) },
  {
    title: t('profiles.order'),
    key: 'models',
    render: (row) => h('div', { class: 'profile-chain' }, row.models.length
      ? row.models.map((item, index) => h('span', { class: 'profile-step' }, [
        h(NTag, { size: 'small', bordered: false, type: index === 0 ? 'primary' : 'default' }, () => (index === 0 ? t('profiles.primary') : t('profiles.fallback', { n: index }))),
        h('span', { class: 'mono' }, profileModelLabel(data.providers, item)),
        h(ModelCaps, { model: item.model }),
      ]))
      : h('span', { style: 'opacity: .5' }, t('profiles.noModels'))),
  },
  {
    title: t('common.actions'),
    key: 'actions',
    align: 'right',
    width: 100,
    render: (row) => h(NSpace, { size: 2, justify: 'end', wrap: false }, () => [
      h(IconAction, { icon: CreateOutline, label: t('common.edit'), onClick: () => openProfile(row) }),
      h(IconAction, { icon: TrashOutline, label: t('common.delete'), type: 'error', onClick: () => removeProfile(row) }),
    ]),
  },
])

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
  {
    title: t('providers.defaultModel'),
    key: 'defaultModel',
    width: 220,
    render: (row) => (row.defaultModel ? h('span', { class: 'model-label' }, [h('span', { class: 'mono model-label-name' }, row.defaultModel), h(ModelCaps, { model: row.defaultModel })]) : '-'),
  },
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
      <NDataTable v-if="data.providers.length" :columns="columns" :data="data.providers" :row-key="(row: Provider) => row.id" :row-props="rowProps" :row-class-name="rowClass" :scroll-x="900" />
      <NEmpty v-else :description="t('providers.empty')">
        <template #extra>
          <NButton type="primary" @click="openCreate">{{ t('providers.add') }}</NButton>
        </template>
      </NEmpty>
    </NCard>

    <NCard class="profiles" :title="t('profiles.title')">
      <template #header-extra>
        <NButton size="small" :disabled="!data.providers.length" @click="openProfile()">
          <template #icon><NIcon><GitBranchOutline /></NIcon></template>
          {{ t('profiles.add') }}
        </NButton>
      </template>
      <p class="profiles-lead">{{ t('profiles.lead') }}</p>
      <NDataTable v-if="data.profiles.length" :columns="profileColumns" :data="data.profiles" :row-key="(row: ModelProfile) => row.id" :row-props="rowProps" :row-class-name="rowClass" :scroll-x="700" />
    </NCard>

    <NModal v-model:show="showProfileEditor" preset="card" :title="editingProfile ? t('profiles.edit') : t('profiles.add')" style="width: min(640px, calc(100vw - 32px))">
      <ProfileForm v-model="profileDraft" />
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showProfileEditor = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="savingProfile" :disabled="!profileDraft.name.trim() || !profileDraft.models.length" @click="saveProfile">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NModal>

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

<style scoped>
:deep(.highlighted td) {
  background: rgba(32, 128, 240, 0.12) !important;
  transition: background-color 0.4s;
}

.profiles {
  margin-top: 16px;
}

.profiles-lead {
  margin: 0 0 12px;
  opacity: 0.7;
  font-size: 13px;
}

:deep(.profile-chain) {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

:deep(.profile-step) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>
