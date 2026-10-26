<script setup lang="ts">
import { AddOutline, CloudDownloadOutline, CloudUploadOutline, CopyOutline, CreateOutline, DownloadOutline, TrashOutline } from '@vicons/ionicons5'
import {
  NAlert, NAvatar, NButton, NCard, NCollapse, NCollapseItem, NDynamicTags, NEmpty, NForm, NFormItem, NGrid, NGridItem, NIcon, NInput, NInputNumber,
  NModal, NSelect, NSpace, NSpin, NTag, useDialog, useMessage,
} from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { call, on } from '../api'
import IconAction from '../components/IconAction.vue'
import { imageAsDataUrl, readPersonaFile } from '../personaCards'
import { useDataStore } from '../stores/data'
import type { AppPlugin, BotPersonaSettings, Persona, PersonaDraft } from '../types'
import { clone, downloadJson } from '../utils'

const { t } = useI18n()
const data = useDataStore()
const message = useMessage()
const dialog = useDialog()

const personas = ref<Persona[]>([])
/** Persona id → names of the bots that use it. */
const usedBy = ref<Record<string, string[]>>({})
const available = ref<boolean>()
const loading = ref(true)

const VARIABLES = ['{bot.name}', '{user.name}', '{user.id}', '{group.id}', '{time}', '{date}', '{weekday}']

async function refresh() {
  try {
    const plugins = await call<AppPlugin[]>('plugins.list')
    available.value = plugins.some((plugin) => plugin.package === '@mushin/plugin-personas' && plugin.status === 'active')
    if (!available.value) return
    personas.value = await call<Persona[]>('personas.list')
    if (!data.loadedBots) await data.refreshBots()
    const uses: Record<string, string[]> = {}
    await Promise.all(data.bots.map(async (bot) => {
      const settings = await call<BotPersonaSettings>('personas.botSettings', { bot: bot.id })
      const ids = new Set([...settings.personas, ...(settings.default ? [settings.default] : []), ...settings.rules.map((rule) => rule.persona)])
      for (const id of ids) (uses[id] ??= []).push(bot.name)
    }))
    usedBy.value = uses
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void refresh()
  if (!data.loadedProviders) data.refreshProviders().catch(() => {})
})
const offs = [on('personas/changed', refresh), on('manager/changed', refresh)]
onBeforeUnmount(() => offs.forEach((off) => off()))

// ---- editing ----

const blank = (): PersonaDraft => ({ name: '', prompt: '', description: '', examples: [], avoid: '', tags: [] })
const showEditor = ref(false)
const editing = ref<string | null>(null)
const draft = ref<PersonaDraft>(blank())
const saving = ref(false)

function openCreate() {
  editing.value = null
  draft.value = blank()
  showEditor.value = true
}

function openEdit(persona: Persona) {
  editing.value = persona.id
  const { id: _id, createdAt: _created, updatedAt: _updated, ...fields } = clone(persona)
  draft.value = { ...blank(), ...fields }
  showEditor.value = true
}

function insertVariable(variable: string) {
  draft.value.prompt += variable
}

const providerOptions = computed(() => data.providers.map((provider) => ({ label: provider.name, value: provider.id })))

/** Leaves out empty optional fields, so they fall back to the bot's settings. */
function payload(value: PersonaDraft) {
  return {
    name: value.name.trim(),
    prompt: value.prompt,
    examples: value.examples.filter((example) => example.user.trim() && example.assistant.trim()),
    tags: value.tags,
    ...(value.avatar ? { avatar: value.avatar } : {}),
    ...(value.description?.trim() ? { description: value.description.trim() } : {}),
    ...(value.avoid?.trim() ? { avoid: value.avoid.trim() } : {}),
    ...(value.provider ? { provider: value.provider } : {}),
    ...(value.model?.trim() ? { model: value.model.trim() } : {}),
    ...(value.temperature !== undefined && value.temperature !== null ? { temperature: value.temperature } : {}),
  }
}

async function save() {
  if (!draft.value.name.trim() || !draft.value.prompt.trim()) {
    message.warning(t('personas.required'))
    return
  }
  saving.value = true
  try {
    const body = payload(draft.value)
    if (editing.value) {
      // Cleared optional fields are sent empty so the old value goes away.
      await call('personas.update', { id: editing.value, avatar: '', description: '', avoid: '', provider: '', model: '', ...body })
    } else {
      await call('personas.create', body)
    }
    showEditor.value = false
    message.success(t('common.saved'))
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

async function duplicate(persona: Persona) {
  try {
    const { id: _id, createdAt: _created, updatedAt: _updated, ...fields } = persona
    await call('personas.import', { data: { ...fields, name: persona.name } })
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  }
}

function remove(persona: Persona) {
  dialog.warning({
    title: t('common.confirmDelete', { name: persona.name }),
    content: usedBy.value[persona.id]?.length ? t('personas.deleteUsed', { bots: usedBy.value[persona.id].join('、') }) : t('personas.deleteHint'),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await call('personas.delete', { id: persona.id })
      message.success(t('common.deleted'))
      await refresh()
    },
  })
}

// ---- avatar, import and export ----

const avatarInput = ref<HTMLInputElement>()
async function pickAvatar(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (!file) return
  if (file.size > 256 * 1024) {
    message.warning(t('personas.avatarTooLarge'))
    return
  }
  draft.value.avatar = await imageAsDataUrl(file)
}

const importInput = ref<HTMLInputElement>()
async function importFiles(event: Event) {
  const files = [...(event.target as HTMLInputElement).files ?? []]
  ;(event.target as HTMLInputElement).value = ''
  let created = 0
  for (const file of files) {
    try {
      const result = await call<{ created: Persona[]; failed: { name: string; error: string }[] }>('personas.import', { data: await readPersonaFile(file) })
      created += result.created.length
      for (const failure of result.failed) message.error(`${failure.name}: ${failure.error}`)
    } catch (error) {
      message.error(`${file.name}: ${(error as Error).message}`)
    }
  }
  if (created) message.success(t('personas.imported', { count: created }))
  await refresh()
}

async function exportPersonas(ids?: string[], name = 'personas') {
  try {
    downloadJson(`${name}.json`, await call('personas.export', { ids }))
  } catch (error) {
    message.error((error as Error).message)
  }
}

const initial = (name: string) => [...name.trim()][0] ?? '?'
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>{{ t('nav.personas') }}</h1>
        <p class="page-lead">{{ t('personas.lead') }}</p>
      </div>
      <NSpace v-if="available">
        <NButton @click="importInput?.click()">
          <template #icon><NIcon><CloudUploadOutline /></NIcon></template>
          {{ t('personas.import') }}
        </NButton>
        <NButton :disabled="!personas.length" @click="exportPersonas()">
          <template #icon><NIcon><CloudDownloadOutline /></NIcon></template>
          {{ t('personas.exportAll') }}
        </NButton>
        <NButton type="primary" data-agent-target="personas.add" @click="openCreate">
          <template #icon><NIcon><AddOutline /></NIcon></template>
          {{ t('personas.add') }}
        </NButton>
      </NSpace>
      <input ref="importInput" type="file" accept=".json,.png,application/json,image/png" multiple hidden @change="importFiles">
    </div>

    <NSpin :show="loading">
      <NAlert v-if="available === false" type="warning" :title="t('personas.unavailable')">
        {{ t('personas.unavailableHint') }}
        <RouterLink to="/plugins?highlight=@mushin/plugin-personas">{{ t('permissions.openPlugins') }}</RouterLink>
      </NAlert>
      <NCard v-else-if="!personas.length && !loading">
        <NEmpty :description="t('personas.empty')">
          <template #extra>
            <NSpace justify="center">
              <NButton type="primary" @click="openCreate">{{ t('personas.add') }}</NButton>
              <NButton @click="importInput?.click()">{{ t('personas.import') }}</NButton>
            </NSpace>
          </template>
        </NEmpty>
      </NCard>
      <NGrid v-else cols="1 700:2 1100:3" responsive="self" :x-gap="16" :y-gap="16">
        <NGridItem v-for="persona in personas" :key="persona.id">
          <NCard size="small" class="persona" hoverable>
            <div class="head">
              <NAvatar round :size="44" :src="persona.avatar || undefined">{{ initial(persona.name) }}</NAvatar>
              <div class="title">
                <strong>{{ persona.name }}</strong>
                <span class="muted desc">{{ persona.description || persona.prompt }}</span>
              </div>
              <NSpace :size="2" :wrap="false">
                <IconAction :icon="CreateOutline" :label="t('common.edit')" @click="openEdit(persona)" />
                <IconAction :icon="CopyOutline" :label="t('personas.duplicate')" @click="duplicate(persona)" />
                <IconAction :icon="DownloadOutline" :label="t('personas.export')" @click="exportPersonas([persona.id], persona.name)" />
                <IconAction :icon="TrashOutline" :label="t('common.delete')" type="error" @click="remove(persona)" />
              </NSpace>
            </div>
            <div class="meta">
              <NTag v-for="tag in persona.tags" :key="tag" size="small" :bordered="false">{{ tag }}</NTag>
              <NTag v-if="persona.examples.length" size="small" :bordered="false" type="info">{{ t('personas.exampleCount', { count: persona.examples.length }) }}</NTag>
              <NTag v-if="persona.model" size="small" :bordered="false" class="mono">{{ persona.model }}</NTag>
            </div>
            <div class="muted used">
              {{ usedBy[persona.id]?.length ? t('personas.usedBy', { bots: usedBy[persona.id].join('、') }) : t('personas.unused') }}
            </div>
          </NCard>
        </NGridItem>
      </NGrid>
    </NSpin>

    <NModal v-model:show="showEditor" preset="card" :title="editing ? t('personas.edit') : t('personas.add')" style="width: min(760px, 96vw)">
      <NForm label-placement="top">
        <div class="identity">
          <div class="avatar">
            <NAvatar round :size="64" :src="draft.avatar || undefined">{{ initial(draft.name || '?') }}</NAvatar>
            <NSpace :size="4" vertical align="center">
              <NButton size="tiny" @click="avatarInput?.click()">{{ t('personas.uploadAvatar') }}</NButton>
              <NButton v-if="draft.avatar" size="tiny" quaternary @click="draft.avatar = ''">{{ t('common.remove') }}</NButton>
            </NSpace>
            <input ref="avatarInput" type="file" accept="image/*" hidden @change="pickAvatar">
          </div>
          <div class="fields">
            <NFormItem :label="t('common.name')" required>
              <NInput v-model:value="draft.name" :maxlength="60" />
            </NFormItem>
            <NFormItem :label="t('personas.description')" :feedback="t('personas.descriptionHint')">
              <NInput v-model:value="draft.description" :maxlength="500" />
            </NFormItem>
          </div>
        </div>
        <NFormItem :label="t('personas.prompt')" required>
          <div class="prompt">
            <NInput v-model:value="draft.prompt" type="textarea" :autosize="{ minRows: 6, maxRows: 16 }" :placeholder="t('personas.promptPlaceholder')" />
            <div class="variables">
              <span class="muted">{{ t('personas.variables') }}</span>
              <NTag v-for="variable in VARIABLES" :key="variable" size="small" class="mono clickable" :bordered="false" @click="insertVariable(variable)">{{ variable }}</NTag>
            </div>
          </div>
        </NFormItem>
        <NFormItem :label="t('personas.examples')" :feedback="t('personas.examplesHint')">
          <div class="examples">
            <div v-for="(example, index) in draft.examples" :key="index" class="example">
              <NInput v-model:value="example.user" :placeholder="t('personas.exampleUser')" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" />
              <NInput v-model:value="example.assistant" :placeholder="t('personas.exampleAssistant')" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" />
              <IconAction :icon="TrashOutline" :label="t('common.remove')" type="error" @click="draft.examples.splice(index, 1)" />
            </div>
            <NButton size="small" dashed @click="draft.examples.push({ user: '', assistant: '' })">
              <template #icon><NIcon><AddOutline /></NIcon></template>
              {{ t('personas.addExample') }}
            </NButton>
          </div>
        </NFormItem>
        <NFormItem :label="t('personas.avoid')" :feedback="t('personas.avoidHint')">
          <NInput v-model:value="draft.avoid" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" />
        </NFormItem>
        <NCollapse>
          <NCollapseItem :title="t('personas.advanced')" name="advanced">
            <NGrid cols="1 600:3" responsive="self" :x-gap="12">
              <NGridItem>
                <NFormItem :label="t('personas.provider')">
                  <NSelect v-model:value="draft.provider" :options="providerOptions" clearable :placeholder="t('personas.botDefault')" />
                </NFormItem>
              </NGridItem>
              <NGridItem>
                <NFormItem :label="t('personas.model')">
                  <NInput v-model:value="draft.model" :placeholder="t('personas.botDefault')" clearable />
                </NFormItem>
              </NGridItem>
              <NGridItem>
                <NFormItem :label="t('personas.temperature')">
                  <NInputNumber v-model:value="draft.temperature" :min="0" :max="2" :step="0.1" clearable :placeholder="t('personas.botDefault')" style="width: 100%" />
                </NFormItem>
              </NGridItem>
            </NGrid>
            <NFormItem :label="t('personas.tags')">
              <NDynamicTags v-model:value="draft.tags" />
            </NFormItem>
          </NCollapseItem>
        </NCollapse>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showEditor = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" @click="save">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.persona {
  height: 100%;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.desc {
  font-size: 13px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 10px;
}

.used {
  margin-top: 8px;
  font-size: 12px;
}

.identity {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.avatar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-top: 24px;
}

.fields {
  flex: 1;
  min-width: 0;
}

.prompt,
.examples {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.variables {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.clickable {
  cursor: pointer;
}

.example {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 8px;
  align-items: start;
}

@media (max-width: 600px) {
  .identity {
    flex-direction: column;
    align-items: stretch;
  }

  .example {
    grid-template-columns: 1fr;
  }
}
</style>
