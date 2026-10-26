<script setup lang="ts">
import { AddOutline, ArrowDownOutline, ArrowUpOutline, TrashOutline } from '@vicons/ionicons5'
import {
  NAlert, NButton, NCard, NDynamicTags, NEmpty, NForm, NFormItem, NIcon, NInput, NRadioButton, NRadioGroup, NSelect, NSpace, NSpin, NSwitch,
  NTag, NTimePicker, useMessage,
} from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { call, on } from '../api'
import type { AppPlugin, Bot, BotPersonaSettings, Persona, PersonaRule } from '../types'
import IconAction from './IconAction.vue'

/** How a bot picks its persona: a default, rules by group, user or time, and the /persona command. */
const props = defineProps<{ bot: Bot }>()
const { t } = useI18n()
const message = useMessage()

const available = ref<boolean>()
const loading = ref(true)
const saving = ref(false)
const personas = ref<Persona[]>([])
const settings = ref<BotPersonaSettings>({ personas: [], rules: [], command: { enabled: true, role: 'admin' }, chats: [] })

async function refresh() {
  try {
    const plugins = await call<AppPlugin[]>('plugins.list')
    available.value = plugins.some((plugin) => plugin.package === '@mushin/plugin-personas' && plugin.status === 'active')
    if (!available.value) return
    personas.value = await call<Persona[]>('personas.list')
    settings.value = await call<BotPersonaSettings>('personas.botSettings', { bot: props.bot.id })
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(refresh)
watch(() => props.bot.id, refresh)
const off = on('manager/changed', refresh)
onBeforeUnmount(off)

const personaOptions = computed(() => personas.value.map((persona) => ({ label: persona.name, value: persona.id })))
const nameOf = (id: string) => personas.value.find((persona) => persona.id === id)?.name ?? id

const whenOptions = computed(() => (['group', 'user', 'private', 'time'] as const).map((value) => ({ value, label: t(`botPersonas.when.${value}`) })))

function addRule() {
  settings.value.rules.push({ when: 'group', ids: [], persona: settings.value.default ?? personas.value[0]?.id ?? '' })
}

function move(index: number, by: number) {
  const rules = settings.value.rules
  const [rule] = rules.splice(index, 1)
  rules.splice(index + by, 0, rule)
}

function ruleInput(rule: PersonaRule) {
  return {
    ...(rule.id ? { id: rule.id } : {}),
    when: rule.when,
    persona: rule.persona,
    ...(rule.when === 'group' || rule.when === 'user' ? { ids: rule.ids ?? [] } : {}),
    ...(rule.when === 'time' ? { from: rule.from, to: rule.to } : {}),
  }
}

async function save() {
  saving.value = true
  try {
    const { chats } = settings.value
    const next = await call<BotPersonaSettings>('personas.updateBotSettings', {
      bot: props.bot.id,
      default: settings.value.default ?? '',
      personas: settings.value.personas,
      rules: settings.value.rules.map(ruleInput),
      command: settings.value.command,
    })
    settings.value = { ...next, chats }
    message.success(t('common.saved'))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

async function resetChat(chat: string) {
  try {
    await call('personas.setChat', { bot: props.bot.id, chat })
    settings.value.chats = settings.value.chats.filter((item) => item.chat !== chat)
  } catch (error) {
    message.error((error as Error).message)
  }
}

const chatLabel = (chat: string) => {
  const [type, id] = chat.split(':')
  return t(type === 'group' ? 'botPersonas.groupChat' : 'botPersonas.privateChat', { id })
}

// ---- try it ----

const probe = ref({ group: '', user: '10000', userName: '', time: null as string | null })
const result = ref<{ persona: { id: string; name: string } | null; reason?: 'chat' | 'rule' | 'default'; rule?: PersonaRule; prepared?: { prompt: string; examples: unknown[] } }>()
const probing = ref(false)

async function tryIt() {
  probing.value = true
  try {
    result.value = await call('personas.resolve', {
      bot: props.bot.id,
      user: probe.value.user || '10000',
      ...(probe.value.group ? { group: probe.value.group } : {}),
      ...(probe.value.userName ? { userName: probe.value.userName } : {}),
      ...(probe.value.time ? { time: probe.value.time } : {}),
    })
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    probing.value = false
  }
}
</script>

<template>
  <NSpin :show="loading">
    <NAlert v-if="available === false" type="warning" :title="t('personas.unavailable')">
      {{ t('personas.unavailableHint') }}
      <RouterLink to="/plugins?highlight=@mushin/plugin-personas">{{ t('permissions.openPlugins') }}</RouterLink>
    </NAlert>
    <NCard v-else-if="!personas.length && !loading">
      <NEmpty :description="t('botPersonas.noPersonas')">
        <template #extra>
          <RouterLink to="/personas"><NButton type="primary">{{ t('botPersonas.openPersonas') }}</NButton></RouterLink>
        </template>
      </NEmpty>
    </NCard>
    <NSpace v-else vertical :size="16">
      <NCard :title="t('botPersonas.title')">
        <p class="muted lead">{{ t('botPersonas.lead') }}</p>
        <NForm label-placement="top">
          <NFormItem :label="t('botPersonas.default')" :feedback="t('botPersonas.defaultHint')">
            <NSelect v-model:value="settings.default" :options="personaOptions" clearable :placeholder="t('botPersonas.none')" />
          </NFormItem>
          <NFormItem :label="t('botPersonas.rules')" :feedback="t('botPersonas.rulesHint')">
            <div class="rules">
              <div v-for="(rule, index) in settings.rules" :key="rule.id ?? index" class="rule">
                <NSelect v-model:value="rule.when" :options="whenOptions" class="when" />
                <NDynamicTags v-if="rule.when === 'group' || rule.when === 'user'" v-model:value="rule.ids" class="target" />
                <NSpace v-else-if="rule.when === 'time'" :size="6" align="center" class="target" :wrap="false">
                  <NTimePicker v-model:formatted-value="rule.from" value-format="HH:mm" format="HH:mm" size="small" clearable />
                  <span>–</span>
                  <NTimePicker v-model:formatted-value="rule.to" value-format="HH:mm" format="HH:mm" size="small" clearable />
                </NSpace>
                <span v-else class="target muted">{{ t('botPersonas.allPrivate') }}</span>
                <span class="arrow">→</span>
                <NSelect v-model:value="rule.persona" :options="personaOptions" class="persona" />
                <NSpace :size="2" :wrap="false">
                  <IconAction :icon="ArrowUpOutline" :label="t('botPersonas.earlier')" :disabled="index === 0" @click="move(index, -1)" />
                  <IconAction :icon="ArrowDownOutline" :label="t('botPersonas.later')" :disabled="index === settings.rules.length - 1" @click="move(index, 1)" />
                  <IconAction :icon="TrashOutline" :label="t('common.remove')" type="error" @click="settings.rules.splice(index, 1)" />
                </NSpace>
              </div>
              <NButton size="small" dashed @click="addRule">
                <template #icon><NIcon><AddOutline /></NIcon></template>
                {{ t('botPersonas.addRule') }}
              </NButton>
            </div>
          </NFormItem>
          <NFormItem :label="t('botPersonas.switchable')" :feedback="t('botPersonas.switchableHint')">
            <NSelect v-model:value="settings.personas" :options="personaOptions" multiple clearable />
          </NFormItem>
          <NFormItem :label="t('botPersonas.command')" :feedback="t('botPersonas.commandHint')">
            <NSpace align="center">
              <NSwitch v-model:value="settings.command.enabled" />
              <NRadioGroup v-model:value="settings.command.role" size="small" :disabled="!settings.command.enabled">
                <NRadioButton value="user">{{ t('botPersonas.roleUser') }}</NRadioButton>
                <NRadioButton value="admin">{{ t('botPersonas.roleAdmin') }}</NRadioButton>
                <NRadioButton value="master">{{ t('botPersonas.roleMaster') }}</NRadioButton>
              </NRadioGroup>
            </NSpace>
          </NFormItem>
        </NForm>
        <NSpace justify="end">
          <NButton type="primary" :loading="saving" @click="save">{{ t('common.save') }}</NButton>
        </NSpace>
      </NCard>

      <NCard v-if="settings.chats.length" :title="t('botPersonas.switchedChats')">
        <div v-for="item in settings.chats" :key="item.chat" class="chat">
          <span>{{ chatLabel(item.chat) }}</span>
          <NTag size="small" :bordered="false" type="info">{{ item.persona.name }}</NTag>
          <NButton size="tiny" quaternary @click="resetChat(item.chat)">{{ t('botPersonas.resetChat') }}</NButton>
        </div>
      </NCard>

      <NCard :title="t('botPersonas.tryTitle')">
        <NSpace align="end">
          <NFormItem :label="t('botPersonas.tryGroup')" :show-feedback="false">
            <NInput v-model:value="probe.group" :placeholder="t('botPersonas.tryPrivate')" clearable style="width: 160px" />
          </NFormItem>
          <NFormItem :label="t('botPersonas.tryUser')" :show-feedback="false">
            <NInput v-model:value="probe.user" style="width: 130px" />
          </NFormItem>
          <NFormItem :label="t('botPersonas.tryUserName')" :show-feedback="false">
            <NInput v-model:value="probe.userName" style="width: 130px" />
          </NFormItem>
          <NFormItem :label="t('botPersonas.tryTime')" :show-feedback="false">
            <NTimePicker v-model:formatted-value="probe.time" value-format="HH:mm" format="HH:mm" clearable :placeholder="t('botPersonas.now')" />
          </NFormItem>
          <NButton :loading="probing" @click="tryIt">{{ t('botPersonas.tryButton') }}</NButton>
        </NSpace>
        <div v-if="result" class="result">
          <template v-if="result.persona">
            <p>
              <NTag type="info" :bordered="false">{{ result.persona.name }}</NTag>
              <span class="muted">
                {{ result.reason === 'rule' ? t('botPersonas.byRule', { when: t(`botPersonas.when.${result.rule?.when}`) }) : t(`botPersonas.reason.${result.reason}`) }}
              </span>
            </p>
            <pre class="prompt">{{ result.prepared?.prompt }}</pre>
          </template>
          <p v-else class="muted">{{ t('botPersonas.noMatch') }}</p>
        </div>
      </NCard>
    </NSpace>
  </NSpin>
</template>

<style scoped>
.lead {
  margin: 0 0 12px;
}

.rules {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rule {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.when {
  width: 130px;
}

.target {
  flex: 1;
  min-width: 180px;
}

.persona {
  width: 160px;
}

.arrow {
  opacity: 0.5;
}

.chat {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.result {
  margin-top: 12px;
}

.prompt {
  white-space: pre-wrap;
  font-size: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.08);
  max-height: 240px;
  overflow: auto;
}
</style>
