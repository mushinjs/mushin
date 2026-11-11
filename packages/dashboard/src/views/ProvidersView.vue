<script setup lang="ts">
import { Button, Dropdown, type DropdownOption, Modal, Tooltip, useConfirm, useToast } from '@mushinjs/ui'
import { nextTick, onMounted, ref, watch } from 'vue'
import IconAction from '../components/IconAction.vue'
import EmptyState from '../components/EmptyState.vue'
import PageHeader from '../components/PageHeader.vue'
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
const message = useToast()
const dialog = useConfirm()

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

const typeName = (id: string) => localize(data.providerTypes.find((type) => type.id === id)?.displayName, locale.value) || id

// ---- rows ----


/** The row's menu: what is not on the row itself. */
function menuOf(provider: Provider): DropdownOption[] {
  return [
    { key: 'default', label: t('providers.makeDefault'), icon: 'i-lucide-star', disabled: provider.isDefault },
    { key: 'edit', label: t('common.edit'), icon: 'i-lucide-pencil' },
    { key: 'divider', type: 'divider' },
    { key: 'delete', label: t('common.delete'), icon: 'i-lucide-trash-2', danger: true },
  ]
}

function onMenu(provider: Provider, key: string) {
  if (key === 'default') void setDefault(provider)
  else if (key === 'edit') openEdit(provider)
  else if (key === 'delete') remove(provider)
}

// A provider has no logo of its own: its initial on a colour picked from its type, the same every time.
const badgeColors = ['#5B6CE0', '#2F9E77', '#C46A2B', '#B84C8C', '#3B8FC4', '#8A63D2', '#B5962A', '#D0574F']
function badgeColor(provider: Provider) {
  let hash = 0
  for (const char of provider.name + provider.type) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return badgeColors[hash % badgeColors.length]
}
const initial = (provider: Provider) => [...provider.name.trim()][0]?.toUpperCase() ?? '?'
</script>

<template>
  <div class="page">
    <PageHeader :title="t('nav.providers')" :lead="t('providers.lead')">
      <Button type="primary" data-agent-target="providers.add" icon="i-lucide-plus" @click="openCreate">
        {{ t('providers.add') }}
      </Button>
    </PageHeader>

    <ul v-if="data.providers.length" class="rows">
      <li
        v-for="provider in data.providers"
        :id="`provider-${provider.id}`"
        :key="provider.id"
        class="row"
        :class="{ highlighted: highlighted === provider.id }"
        tabindex="0"
        @click="openEdit(provider)"
        @keyup.enter.self="openEdit(provider)"
      >
        <span class="badge" :style="{ background: badgeColor(provider) }" aria-hidden="true">{{ initial(provider) }}</span>
        <div class="main">
          <div class="title">
            <strong>{{ provider.name }}</strong>
            <span v-if="provider.isDefault" class="tag primary"><span class="i-ph-star-fill text-[12px]" />{{ t('common.default') }}</span>
            <span v-if="!provider.typeAvailable" class="tag warn">{{ t('providers.typeMissing') }}</span>
            <span v-if="!provider.capabilities?.includes('chat')" class="tag info" :title="t('providers.decisionOnlyHint')">{{ t('providers.decisionOnly') }}</span>
          </div>
          <div class="sub">
            <span>{{ typeName(provider.type) }}</span>
            <span class="sep">·</span>
            <span>{{ t('providers.modelCount', provider.models.length) }}</span>
            <template v-if="provider.defaultModel">
              <span class="sep">·</span>
              <span class="model-label"><span class="mono model-label-name">{{ provider.defaultModel }}</span><ModelCaps :model="provider.defaultModel" /></span>
            </template>
          </div>
        </div>
        <div class="health" @click.stop>
          <Tooltip v-if="provider.lastTest && !provider.lastTest.ok" :max-width="320">
            <template #trigger>
              <span class="pill bad"><span class="dot" />{{ t('providers.unreachable') }}</span>
            </template>
            {{ provider.lastTest.error }}
          </Tooltip>
          <span v-else-if="provider.lastTest" class="pill ok"><span class="dot" />{{ provider.lastTest.latencyMs }} ms</span>
          <Button size="small" :secondary="!provider.lastTest" :quaternary="!!provider.lastTest" :type="provider.lastTest ? 'default' : 'primary'" :loading="testing === provider.id" icon="i-lucide-zap" @click="test(provider)">
            {{ provider.lastTest ? t('providers.retest') : t('common.test') }}
          </Button>
          <Dropdown placement="bottom" align="end" :options="menuOf(provider)" @select="(key: string) => onMenu(provider, key)">
            <Button size="small" quaternary circle :aria-label="t('common.actions')" icon="i-lucide-ellipsis" />
          </Dropdown>
        </div>
      </li>
    </ul>
    <EmptyState v-else icon="i-lucide-key-round" :title="t('providers.empty')" :hint="t('providers.emptyHint')">
      <Button type="primary" @click="openCreate">{{ t('providers.add') }}</Button>
    </EmptyState>

    <section class="profiles">
      <header class="section-head">
        <div>
          <h2>{{ t('profiles.title') }}</h2>
          <p class="section-lead" :title="t('profiles.lead')">{{ t('profiles.lead') }}</p>
        </div>
        <Button :disabled="!data.providers.length" icon="i-lucide-git-branch" @click="openProfile()">
          {{ t('profiles.add') }}
        </Button>
      </header>
      <ul v-if="data.profiles.length" class="rows">
        <li
          v-for="profile in data.profiles"
          :id="`provider-${profile.id}`"
          :key="profile.id"
          class="row profile"
          :class="{ highlighted: highlighted === profile.id }"
          tabindex="0"
          @click="openProfile(profile)"
          @keyup.enter.self="openProfile(profile)"
        >
          <span class="badge chain-badge" aria-hidden="true"><span class="i-lucide-git-branch text-[16px]" /></span>
          <div class="main">
            <div class="title"><strong>{{ profile.name }}</strong></div>
            <div class="chain">
              <template v-for="(item, index) in profile.models" :key="index">
                <span v-if="index" class="i-lucide-arrow-right chain-arrow text-[12px]" />
                <span class="step" :class="{ first: !index }">
                  <span class="mono">{{ profileModelLabel(data.providers, item) }}</span>
                  <ModelCaps :model="item.model" />
                </span>
              </template>
              <span v-if="!profile.models.length" class="faint">{{ t('profiles.noModels') }}</span>
            </div>
          </div>
          <div class="health" @click.stop>
            <IconAction icon="i-lucide-pencil" :label="t('common.edit')" @click="openProfile(profile)" />
            <IconAction icon="i-lucide-trash-2" :label="t('common.delete')" type="error" @click="removeProfile(profile)" />
          </div>
        </li>
      </ul>
      <p v-else class="faint none">{{ t('profiles.none') }}</p>
    </section>

    <Modal v-model:show="showProfileEditor" :title="editingProfile ? t('profiles.edit') : t('profiles.add')" :width="640">
      <ProfileForm v-model="profileDraft" />
      <template #footer>
        <Button @click="showProfileEditor = false">{{ t('common.cancel') }}</Button>
        <Button type="primary" :loading="savingProfile" :disabled="!profileDraft.name.trim() || !profileDraft.models.length" @click="saveProfile">{{ t('common.save') }}</Button>
      </template>
    </Modal>

    <Modal v-model:show="showEditor" :title="editing ? t('providers.edit') : t('providers.add')" :width="600">
      <ProviderForm v-model="draft" :types="data.providerTypes" :provider-id="editing ?? undefined" />
      <template #footer>
        <Button @click="showEditor = false">{{ t('common.cancel') }}</Button>
        <Button type="primary" :loading="saving" :disabled="!draft.name" @click="save">{{ t('common.save') }}</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  min-height: 64px;
  padding: 10px 12px 10px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.4s;
}

.row:hover {
  border-color: var(--primary);
  box-shadow: var(--shadow);
}

.row:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.row.highlighted {
  background: var(--primary-soft);
}

.badge {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 650;
  font-size: 16px;
}

.chain-badge {
  background: var(--s2);
  color: var(--fg2);
}

.main {
  min-width: 0;
}

.title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
  padding: 0 7px;
  border-radius: 10px;
  font-size: 11.5px;
  white-space: nowrap;
}

.tag.primary { color: var(--primary); background: var(--primary-soft); }
.tag.warn { color: var(--warn); background: var(--warn-soft); }
.tag.info { color: var(--info); background: var(--info-soft); }

.sub {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  min-width: 0;
  font-size: 12.5px;
  color: var(--fg2);
  white-space: nowrap;
  overflow: hidden;
}

.sep {
  color: var(--fg3);
}

.health {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: default;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 9px;
  border-radius: 11px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.pill.ok { color: var(--ok); background: var(--ok-soft); }
.pill.bad { color: var(--bad); background: var(--bad-soft); }

.profiles {
  margin-top: 32px;
}

.section-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 16px;
  margin-bottom: 12px;
}

.section-head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.section-head .section-lead {
  margin: 4px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chain {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin-top: 4px;
  font-size: 12.5px;
  color: var(--fg2);
}

.step {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 6px;
  background: var(--s2);
}

.step.first {
  color: var(--primary);
  background: var(--primary-soft);
}

.chain-arrow {
  color: var(--fg3);
}

.faint {
  color: var(--fg3);
  font-size: 13px;
}

.none {
  margin: 0;
  padding: 16px;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  text-align: center;
}

@media (max-width: 640px) {
  .row {
    grid-template-columns: 40px minmax(0, 1fr);
  }

  .health {
    grid-column: 1 / -1;
    justify-content: flex-end;
  }
}
</style>
