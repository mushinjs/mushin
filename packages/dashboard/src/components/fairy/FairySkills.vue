<script setup lang="ts">
import { Button, Card, Empty, Form, FormItem, Input, Modal, Select, Tag, Toggle, useConfirm, useToast } from '@mushinjs/ui'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../../api'
import { useFairyStore } from '../../stores/fairy'
import { SCENES } from '../../stores/fairyScene'
import type { FairySkill } from '../../types'
import IconAction from '../IconAction.vue'

const { t } = useI18n()
const message = useToast()
const dialog = useConfirm()
const fairy = useFairyStore()

const actionNames = ref<string[]>([])
const editing = ref<Partial<FairySkill> & { isNew?: boolean }>()
const saving = ref(false)
const fileInput = ref<HTMLInputElement>()

onMounted(async () => {
  fairy.refreshPickers().catch(() => {})
  try {
    actionNames.value = (await call<{ name: string }[]>('fairy.policy.list')).map((item) => item.name)
  } catch {}
})

const sorted = computed(() => [...fairy.skills].sort((a, b) => ['user', 'plugin', 'builtin'].indexOf(a.source) - ['user', 'plugin', 'builtin'].indexOf(b.source)))
const toolOptions = computed(() => actionNames.value.map((name) => ({ label: name, value: name })))
const sceneOptions = SCENES.map((scene) => ({ label: t(`fairyScene.name.${scene}`), value: scene }))

function sourceLabel(skill: FairySkill) {
  return skill.source === 'plugin' ? skill.plugin ?? t('fairyPalette.source.plugin') : t(`fairyPalette.source.${skill.source}`)
}

function openNew() {
  editing.value = { isNew: true, name: '', description: '', instructions: '', tools: [], scenes: [] }
}

function openEdit(skill: FairySkill) {
  editing.value = { ...skill, tools: [...skill.tools ?? []], scenes: [...skill.scenes ?? []] }
}

async function save() {
  const skill = editing.value
  if (!skill?.name?.trim() || !skill.instructions?.trim()) {
    message.warning(t('fairyPage.skills.required'))
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
    if (skill.isNew) await call('fairy.skills.create', body)
    else await call('fairy.skills.update', { id: skill.id, ...body })
    editing.value = undefined
    await fairy.refreshPickers()
    message.success(t('common.saved'))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

async function setEnabled(skill: FairySkill, enabled: boolean) {
  await call('fairy.skills.setEnabled', { id: skill.id, enabled })
  await fairy.refreshPickers()
}

function remove(skill: FairySkill) {
  const builtinCopy = BUILTIN_IDS.has(skill.id)
  dialog.warning({
    title: builtinCopy ? t('fairyPage.skills.restoreTitle') : t('common.confirmDelete', { name: skill.name }),
    content: builtinCopy ? t('fairyPage.skills.restoreText') : undefined,
    positiveText: builtinCopy ? t('fairyPage.skills.restore') : t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await call('fairy.skills.delete', { id: skill.id })
      await fairy.refreshPickers()
    },
  })
}

/** Ids of the skills that ship with Fairy; a user skill with one of them customizes it. */
const BUILTIN_IDS = new Set(['diagnose-bot', 'build-flow', 'fix-flow', 'connect-provider'])

async function exportSkill(skill: FairySkill) {
  const { markdown } = await call<{ markdown: string }>('fairy.skills.export', { id: skill.id })
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
      await call('fairy.skills.import', { markdown: await file.text() })
      count++
    } catch (error) {
      message.error(`${file.name}: ${(error as Error).message}`)
    }
  }
  if (count) message.success(t('fairyPage.skills.imported', { count }))
  await fairy.refreshPickers()
}
</script>

<template>
  <div class="skills">
    <div class="toolbar">
      <p class="hint">{{ t('fairyPage.skills.lead') }}</p>
      <div class="flex flex-wrap gap-x-3 gap-y-2 items-center">
        <Button icon="i-lucide-cloud-upload" @click="fileInput?.click()">
          {{ t('fairyPage.skills.import') }}
        </Button>
        <Button type="primary" icon="i-lucide-plus" @click="openNew">
          {{ t('fairyPage.skills.add') }}
        </Button>
      </div>
      <input ref="fileInput" type="file" accept=".md,text/markdown" multiple hidden @change="importFiles">
    </div>

    <Empty v-if="!fairy.skills.length" />
    <div class="grid">
      <Card v-for="skill in sorted" :key="skill.id" size="small" class="skill" :class="{ off: !skill.enabled }">
        <div class="skill-head">
          <div class="skill-name">
            <span>{{ skill.name }}</span>
            <Tag size="tiny" :type="skill.source === 'user' ? 'success' : skill.source === 'plugin' ? 'info' : 'default'">{{ sourceLabel(skill) }}</Tag>
            <Tag v-if="skill.source === 'user' && BUILTIN_IDS.has(skill.id)" size="tiny" type="warning">{{ t('fairyPage.skills.customized') }}</Tag>
          </div>
          <Toggle variant="button" size="small" :value="skill.enabled" @update:value="(on: boolean) => setEnabled(skill, on)" />
        </div>
        <p class="skill-desc">{{ skill.description }}</p>
        <div v-if="skill.scenes?.length" class="skill-tags">
          <Tag v-for="scene in skill.scenes" :key="scene" size="tiny">{{ t(`fairyScene.name.${scene}`) }}</Tag>
        </div>
        <template #action>
          <div class="skill-actions">
            <span class="mono hint small">${{ skill.id }}</span>
            <span>
              <IconAction icon="i-lucide-pencil" :label="t('common.edit')" @click="openEdit(skill)" />
              <IconAction icon="i-lucide-cloud-download" :label="t('fairyPage.skills.export')" @click="exportSkill(skill)" />
              <IconAction icon="i-lucide-trash-2" v-if="skill.source === 'user'" :label="BUILTIN_IDS.has(skill.id) ? t('fairyPage.skills.restore') : t('common.delete')" @click="remove(skill)" />
            </span>
          </div>
        </template>
      </Card>
    </div>

    <Modal :show="!!editing" :title="editing?.isNew ? t('fairyPage.skills.add') : t('fairyPage.skills.edit')" :style="{ width: '640px', maxWidth: '95vw' }" @update:show="(show: boolean) => !show && (editing = undefined)">
      <Form v-if="editing">
        <p v-if="!editing.isNew && editing.source !== 'user'" class="hint small">{{ t('fairyPage.skills.copyNote') }}</p>
        <FormItem :label="t('common.name')" required>
          <Input v-model:value="editing.name" :maxlength="80" />
        </FormItem>
        <FormItem :label="t('fairyPage.skills.description')">
          <Input v-model:value="editing.description" :maxlength="300" />
        </FormItem>
        <FormItem :label="t('fairyPage.skills.whenToUse')">
          <Input v-model:value="editing.whenToUse" :maxlength="500" />
        </FormItem>
        <FormItem :label="t('fairyPage.skills.instructions')" required :feedback="t('fairyPage.skills.instructionsHelp')">
          <Input v-model:value="editing.instructions" type="textarea" class="mono" :autosize="{ minRows: 6, maxRows: 16 }" />
        </FormItem>
        <FormItem :label="t('fairyPage.skills.tools')">
          <Select v-model:value="editing.tools" multiple filterable tag :options="toolOptions" />
        </FormItem>
        <FormItem :label="t('fairyPage.skills.scenes')">
          <Select v-model:value="editing.scenes" multiple :options="sceneOptions" />
        </FormItem>
      </Form>
      <template #action>
        <div class="flex flex-wrap gap-x-3 gap-y-2 items-center justify-end">
          <Button @click="editing = undefined">{{ t('common.cancel') }}</Button>
          <Button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</Button>
        </div>
      </template>
    </Modal>
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
