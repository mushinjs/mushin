<script setup lang="ts">
import { AddOutline, CloudDownloadOutline, CloudUploadOutline, CreateOutline, TrashOutline } from '@vicons/ionicons5'
import {
  NButton, NCard, NEmpty, NForm, NFormItem, NIcon, NInput, NModal, NSelect, NSpace, NSwitch, NTag, useDialog, useMessage,
} from 'naive-ui'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../../api'
import { useAgentStore } from '../../stores/agent'
import { SCENES } from '../../stores/agentScene'
import type { AgentSkill } from '../../types'
import IconAction from '../IconAction.vue'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const agent = useAgentStore()

const actionNames = ref<string[]>([])
const editing = ref<Partial<AgentSkill> & { isNew?: boolean }>()
const saving = ref(false)
const fileInput = ref<HTMLInputElement>()

onMounted(async () => {
  agent.refreshPickers().catch(() => {})
  try {
    actionNames.value = (await call<{ name: string }[]>('agent.policy.list')).map((item) => item.name)
  } catch {}
})

const sorted = computed(() => [...agent.skills].sort((a, b) => ['user', 'plugin', 'builtin'].indexOf(a.source) - ['user', 'plugin', 'builtin'].indexOf(b.source)))
const toolOptions = computed(() => actionNames.value.map((name) => ({ label: name, value: name })))
const sceneOptions = SCENES.map((scene) => ({ label: t(`agentScene.name.${scene}`), value: scene }))

function sourceLabel(skill: AgentSkill) {
  return skill.source === 'plugin' ? skill.plugin ?? t('agentPalette.source.plugin') : t(`agentPalette.source.${skill.source}`)
}

function openNew() {
  editing.value = { isNew: true, name: '', description: '', instructions: '', tools: [], scenes: [] }
}

function openEdit(skill: AgentSkill) {
  editing.value = { ...skill, tools: [...skill.tools ?? []], scenes: [...skill.scenes ?? []] }
}

async function save() {
  const skill = editing.value
  if (!skill?.name?.trim() || !skill.instructions?.trim()) {
    message.warning(t('agentPage.skills.required'))
    return
  }
  saving.value = true
  const body = {
    name: skill.name,
    description: skill.description ?? '',
    instructions: skill.instructions,
    whenToUse: skill.whenToUse || undefined,
    tools: skill.tools,
    scenes: skill.scenes,
  }
  try {
    if (skill.isNew) await call('agent.skills.create', body)
    else await call('agent.skills.update', { id: skill.id, ...body })
    editing.value = undefined
    await agent.refreshPickers()
    message.success(t('common.saved'))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

async function setEnabled(skill: AgentSkill, enabled: boolean) {
  await call('agent.skills.setEnabled', { id: skill.id, enabled })
  await agent.refreshPickers()
}

function remove(skill: AgentSkill) {
  const builtinCopy = BUILTIN_IDS.has(skill.id)
  dialog.warning({
    title: builtinCopy ? t('agentPage.skills.restoreTitle') : t('common.confirmDelete', { name: skill.name }),
    content: builtinCopy ? t('agentPage.skills.restoreText') : undefined,
    positiveText: builtinCopy ? t('agentPage.skills.restore') : t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await call('agent.skills.delete', { id: skill.id })
      await agent.refreshPickers()
    },
  })
}

/** Ids of the skills that ship with the Agent; a user skill with one of them customizes it. */
const BUILTIN_IDS = new Set(['diagnose-bot', 'build-flow', 'fix-flow', 'connect-provider'])

async function exportSkill(skill: AgentSkill) {
  const { markdown } = await call<{ markdown: string }>('agent.skills.export', { id: skill.id })
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${skill.id}.SKILL.md`
  link.click()
  URL.revokeObjectURL(url)
}

async function importFiles(event: Event) {
  const files = [...(event.target as HTMLInputElement).files ?? []]
  ;(event.target as HTMLInputElement).value = ''
  let count = 0
  for (const file of files) {
    try {
      await call('agent.skills.import', { markdown: await file.text() })
      count++
    } catch (error) {
      message.error(`${file.name}: ${(error as Error).message}`)
    }
  }
  if (count) message.success(t('agentPage.skills.imported', { count }))
  await agent.refreshPickers()
}
</script>

<template>
  <div class="skills">
    <div class="toolbar">
      <p class="hint">{{ t('agentPage.skills.lead') }}</p>
      <NSpace>
        <NButton @click="fileInput?.click()">
          <template #icon><NIcon><CloudUploadOutline /></NIcon></template>
          {{ t('agentPage.skills.import') }}
        </NButton>
        <NButton type="primary" @click="openNew">
          <template #icon><NIcon><AddOutline /></NIcon></template>
          {{ t('agentPage.skills.add') }}
        </NButton>
      </NSpace>
      <input ref="fileInput" type="file" accept=".md,text/markdown" multiple hidden @change="importFiles">
    </div>

    <NEmpty v-if="!agent.skills.length" />
    <div class="grid">
      <NCard v-for="skill in sorted" :key="skill.id" size="small" class="skill" :class="{ off: !skill.enabled }">
        <div class="skill-head">
          <div class="skill-name">
            <span>{{ skill.name }}</span>
            <NTag size="tiny" :type="skill.source === 'user' ? 'success' : skill.source === 'plugin' ? 'info' : 'default'" :bordered="false">{{ sourceLabel(skill) }}</NTag>
            <NTag v-if="skill.source === 'user' && BUILTIN_IDS.has(skill.id)" size="tiny" type="warning" :bordered="false">{{ t('agentPage.skills.customized') }}</NTag>
          </div>
          <NSwitch size="small" :value="skill.enabled" @update:value="(on: boolean) => setEnabled(skill, on)" />
        </div>
        <p class="skill-desc">{{ skill.description }}</p>
        <div v-if="skill.scenes?.length" class="skill-tags">
          <NTag v-for="scene in skill.scenes" :key="scene" size="tiny" :bordered="false">{{ t(`agentScene.name.${scene}`) }}</NTag>
        </div>
        <template #action>
          <div class="skill-actions">
            <span class="mono hint small">${{ skill.id }}</span>
            <span>
              <IconAction :icon="CreateOutline" :label="t('common.edit')" @click="openEdit(skill)" />
              <IconAction :icon="CloudDownloadOutline" :label="t('agentPage.skills.export')" @click="exportSkill(skill)" />
              <IconAction :icon="TrashOutline" v-if="skill.source === 'user'" :label="BUILTIN_IDS.has(skill.id) ? t('agentPage.skills.restore') : t('common.delete')" @click="remove(skill)" />
            </span>
          </div>
        </template>
      </NCard>
    </div>

    <NModal :show="!!editing" preset="card" :title="editing?.isNew ? t('agentPage.skills.add') : t('agentPage.skills.edit')" :style="{ width: '640px', maxWidth: '95vw' }" @update:show="(show: boolean) => !show && (editing = undefined)">
      <NForm v-if="editing" label-placement="top">
        <p v-if="!editing.isNew && editing.source !== 'user'" class="hint small">{{ t('agentPage.skills.copyNote') }}</p>
        <NFormItem :label="t('common.name')" required>
          <NInput v-model:value="editing.name" maxlength="80" />
        </NFormItem>
        <NFormItem :label="t('agentPage.skills.description')">
          <NInput v-model:value="editing.description" maxlength="300" />
        </NFormItem>
        <NFormItem :label="t('agentPage.skills.whenToUse')">
          <NInput v-model:value="editing.whenToUse" maxlength="500" />
        </NFormItem>
        <NFormItem :label="t('agentPage.skills.instructions')" required :feedback="t('agentPage.skills.instructionsHelp')">
          <NInput v-model:value="editing.instructions" type="textarea" class="mono" :autosize="{ minRows: 6, maxRows: 16 }" />
        </NFormItem>
        <NFormItem :label="t('agentPage.skills.tools')">
          <NSelect v-model:value="editing.tools" multiple filterable tag :options="toolOptions" />
        </NFormItem>
        <NFormItem :label="t('agentPage.skills.scenes')">
          <NSelect v-model:value="editing.scenes" multiple :options="sceneOptions" />
        </NFormItem>
      </NForm>
      <template #action>
        <NSpace justify="end">
          <NButton @click="editing = undefined">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" @click="save">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.toolbar p {
  margin: 0;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}

.skill.off {
  opacity: 0.6;
}

.skill-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}

.skill-name {
  display: flex;
  gap: 6px;
  align-items: center;
  font-weight: 600;
  flex-wrap: wrap;
}

.skill-desc {
  font-size: 13px;
  opacity: 0.75;
  margin: 6px 0;
  line-height: 1.5;
}

.skill-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.skill-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.small {
  font-size: 12px;
}

.hint {
  opacity: 0.65;
}
</style>
