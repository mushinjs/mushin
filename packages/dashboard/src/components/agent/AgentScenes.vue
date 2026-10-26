<script setup lang="ts">
import { AddOutline, TrashOutline } from '@vicons/ionicons5'
import { NButton, NCard, NForm, NFormItem, NIcon, NInput, NSelect, NSpace, NSwitch, NTag, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../../api'
import { useAgentStore } from '../../stores/agent'
import { SCENE_RECOMMENDATIONS, SCENES, type SceneProfile, useAgentSceneStore } from '../../stores/agentScene'
import { clone } from '../../utils'

const { t } = useI18n()
const message = useMessage()
const agent = useAgentStore()
const scenes = useAgentSceneStore()

const selected = ref<string>('overview')
const draft = ref<SceneProfile>({})
const saving = ref(false)

watch([selected, () => scenes.profiles], () => {
  draft.value = clone(scenes.profiles[selected.value] ?? {})
}, { immediate: true, deep: true })

const skillOptions = computed(() => agent.skills.map((skill) => ({ label: skill.name, value: skill.id })))
const builtins = computed(() => SCENE_RECOMMENDATIONS[selected.value] ?? [])
const changed = (scene: string) => Object.keys(scenes.profiles[scene] ?? {}).length > 0

function toggleBuiltin(id: string, on: boolean) {
  const hidden = new Set(draft.value.hidden ?? [])
  if (on) hidden.delete(id)
  else hidden.add(id)
  draft.value.hidden = [...hidden]
}

function addRecommendation() {
  draft.value.recommendations = [...draft.value.recommendations ?? [], { text: '' }]
}

/** Leaves out empty fields, so the dashboard's defaults apply. */
function cleaned(profile: SceneProfile): SceneProfile | null {
  const result: SceneProfile = {}
  if (profile.hint?.trim()) result.hint = profile.hint.trim()
  if (profile.welcome?.trim()) result.welcome = profile.welcome.trim()
  const recommendations = (profile.recommendations ?? []).filter((item) => item.text.trim())
  if (recommendations.length) result.recommendations = recommendations.map((item) => ({ text: item.text.trim(), ...(item.prompt?.trim() ? { prompt: item.prompt.trim() } : {}), ...(item.skill ? { skill: item.skill } : {}) }))
  if (profile.hidden?.length) result.hidden = profile.hidden
  if (profile.skills?.length) result.skills = profile.skills
  if (profile.autoShow === false) result.autoShow = false
  return Object.keys(result).length ? result : null
}

async function save(reset = false) {
  saving.value = true
  try {
    await call('agent.profiles.update', { scene: selected.value, profile: reset ? null : cleaned(draft.value) })
    await scenes.refreshProfiles()
    message.success(reset ? t('agentPage.scenes.restored') : t('common.saved'))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="scenes">
    <nav class="scene-list">
      <button
        v-for="scene in SCENES"
        :key="scene"
        type="button"
        class="scene-item hover-row"
        :class="{ active: scene === selected }"
        @click="selected = scene"
      >
        <span>{{ t(`agentScene.name.${scene}`) }}</span>
        <NTag v-if="changed(scene)" size="tiny" type="info" :bordered="false">{{ t('agentPage.scenes.custom') }}</NTag>
      </button>
    </nav>

    <NCard :title="t(`agentScene.name.${selected}`)" class="scene-editor">
      <NForm label-placement="top">
        <NFormItem :label="t('agentPage.scenes.hint')" :feedback="t('agentPage.scenes.hintHelp')">
          <NInput v-model:value="draft.hint" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :placeholder="t(`agentScene.hint.${selected}`)" />
        </NFormItem>
        <NFormItem :label="t('agentPage.scenes.welcome')">
          <NInput v-model:value="draft.welcome" :placeholder="t('agent.hello')" />
        </NFormItem>
        <NFormItem :label="t('agentPage.scenes.builtin')" :feedback="t('agentPage.scenes.builtinHelp')">
          <div class="builtin-list">
            <label v-for="id in builtins" :key="id" class="builtin">
              <NSwitch size="small" :value="!draft.hidden?.includes(id)" @update:value="(on: boolean) => toggleBuiltin(id, on)" />
              <span>{{ t(`agentScene.rec.${id}`, { name: '…', count: 'N', names: '…' }) }}</span>
            </label>
          </div>
        </NFormItem>
        <NFormItem :label="t('agentPage.scenes.own')">
          <div class="own-list">
            <div v-for="(item, index) in draft.recommendations ?? []" :key="index" class="own">
              <NInput v-model:value="item.text" :placeholder="t('agentPage.scenes.ownText')" />
              <NInput v-model:value="item.prompt" :placeholder="t('agentPage.scenes.ownPrompt')" />
              <NSelect v-model:value="item.skill" clearable :options="skillOptions" :placeholder="t('agentPage.scenes.ownSkill')" />
              <NButton quaternary circle :aria-label="t('common.remove')" @click="draft.recommendations!.splice(index, 1)">
                <template #icon><NIcon><TrashOutline /></NIcon></template>
              </NButton>
            </div>
            <NButton dashed size="small" @click="addRecommendation">
              <template #icon><NIcon><AddOutline /></NIcon></template>
              {{ t('agentPage.scenes.addOwn') }}
            </NButton>
          </div>
        </NFormItem>
        <NFormItem :label="t('agentPage.scenes.skills')" :feedback="t('agentPage.scenes.skillsHelp')">
          <NSelect v-model:value="draft.skills" multiple clearable :options="skillOptions" />
        </NFormItem>
        <NFormItem :label="t('agentPage.scenes.autoShow')" :feedback="t('agentPage.scenes.autoShowHelp')">
          <NSwitch :value="draft.autoShow !== false" @update:value="(on: boolean) => (draft.autoShow = on ? undefined : false)" />
        </NFormItem>
      </NForm>
      <template #action>
        <NSpace justify="end">
          <NButton :disabled="!changed(selected)" :loading="saving" @click="save(true)">{{ t('agentPage.scenes.restore') }}</NButton>
          <NButton type="primary" :loading="saving" @click="save()">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NCard>
  </div>
</template>

<style scoped>
.scenes {
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: 16px;
  align-items: start;
}

.scene-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.scene-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.scene-item.active {
  background: rgba(124, 139, 217, 0.16);
  font-weight: 500;
}

.builtin-list,
.own-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.builtin {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
}

.own {
  display: grid;
  grid-template-columns: 1fr 1fr 180px auto;
  gap: 6px;
}

@media (max-width: 900px) {
  .scenes {
    grid-template-columns: 1fr;
  }

  .scene-list {
    flex-direction: row;
    flex-wrap: wrap;
  }

  .own {
    grid-template-columns: 1fr;
  }
}
</style>
