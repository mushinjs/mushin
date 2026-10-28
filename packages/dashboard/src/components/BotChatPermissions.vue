<script setup lang="ts">
import { AddOutline, CreateOutline, TrashOutline } from '@vicons/ionicons5'
import {
  type DataTableColumns, NAlert, NButton, NCard, NDataTable, NDynamicTags, NEmpty, NForm, NFormItem, NIcon, NInput, NModal, NRadioButton, NRadioGroup, NSelect, NSpace,
  NSwitch, NTag, useDialog, useMessage,
} from 'naive-ui'
import { computed, h, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../api'
import type { Bot } from '../types'
import { formatTime } from '../utils'
import IconAction from './IconAction.vue'

interface ChatMember {
  user: string
  role: 'admin' | 'member'
  tags: string[]
  blocked: boolean
  note: string
  joinedAt: number
}

interface ChatRule {
  id: number
  feature: string
  effect: 'off' | 'tags'
  tags: string[]
  note: string
}

/** One bot's chats: their members (chat admins, tags, blocked users) and rules, kept in the database. */
const props = defineProps<{ bot: Bot; chatCommands: boolean }>()
const emit = defineEmits<{ 'update:chatCommands': [value: boolean] }>()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

const channels = ref<{ value: string; label: string }[]>([])
const channel = ref<string>()
const members = ref<ChatMember[]>([])
const rules = ref<ChatRule[]>([])
const loading = ref(false)

const channelLabel = (key: string, name?: string) => {
  const [type, ...rest] = key.split(':')
  const id = rest.join(':')
  return `${type === 'group' ? t('chatPermissions.group') : t('chatPermissions.private')} ${name ? `${name} (${id})` : id}`
}

/** Chats with members or rules first, then chats the bot saw recently. */
async function loadChannels() {
  try {
    const [kept, recent] = await Promise.all([
      call<{ channel: string; members: number; rules: number }[]>('permissions.chats', { bot: props.bot.id }),
      call<{ type: string; id: string; name?: string }[]>('bots.channels', { id: props.bot.id }).catch(() => []),
    ])
    const names = new Map(recent.map((item) => [`${item.type}:${item.id}`, item.name]))
    const keys = [...new Set([...kept.map((item) => item.channel), ...recent.filter((item) => item.type === 'group').map((item) => `${item.type}:${item.id}`)])]
    channels.value = keys.map((key) => ({ value: key, label: channelLabel(key, names.get(key)) }))
    if (!channel.value && keys.length) channel.value = keys[0]
  } catch (error) {
    message.error((error as Error).message)
  }
}

async function loadChat() {
  if (!channel.value) return
  loading.value = true
  try {
    const [nextMembers, nextRules] = await Promise.all([
      call<ChatMember[]>('permissions.members.list', { bot: props.bot.id, channel: channel.value }),
      call<ChatRule[]>('permissions.rules.list', { bot: props.bot.id, channel: channel.value }),
    ])
    members.value = nextMembers
    rules.value = nextRules
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(loadChannels)
watch(() => props.bot.id, () => {
  channel.value = undefined
  void loadChannels()
})
watch(channel, loadChat)

/** Typing `group:123` (or just the number) picks a chat that is not listed yet. */
function pickChannel(value: string | null) {
  if (!value) return
  const key = value.includes(':') ? value.trim() : `group:${value.trim()}`
  if (!channels.value.some((item) => item.value === key)) channels.value = [{ value: key, label: channelLabel(key) }, ...channels.value]
  channel.value = key
}

async function setCommands(value: boolean) {
  try {
    await call('permissions.update', { bot: props.bot.id, chatCommands: value })
    emit('update:chatCommands', value)
  } catch (error) {
    message.error((error as Error).message)
  }
}

// ---- members ----

const editing = ref<ChatMember & { isNew: boolean }>()
const saving = ref(false)

function addMember() {
  editing.value = { user: '', role: 'member', tags: [], blocked: false, note: '', joinedAt: 0, isNew: true }
}

async function saveMember() {
  if (!editing.value || !channel.value) return
  const { user, role, tags, blocked, note } = editing.value
  saving.value = true
  try {
    await call('permissions.members.set', { bot: props.bot.id, channel: channel.value, user: user.trim(), role, tags, blocked, note })
    editing.value = undefined
    message.success(t('common.saved'))
    await Promise.all([loadChat(), loadChannels()])
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

function removeMember(member: ChatMember) {
  dialog.warning({
    title: t('chatPermissions.removeMember'),
    content: t('chatPermissions.removeMemberHint', { user: member.user }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await call('permissions.members.act', { bot: props.bot.id, channel: channel.value, user: member.user, action: 'remove' })
        await loadChat()
      } catch (error) {
        message.error((error as Error).message)
      }
    },
  })
}

const memberColumns = computed<DataTableColumns<ChatMember>>(() => [
  { key: 'user', title: t('chatPermissions.user'), render: (row) => h('span', { class: 'mono' }, row.user) },
  {
    key: 'role',
    title: t('chatPermissions.role'),
    width: 110,
    render: (row) => h(NTag, { size: 'small', bordered: false, type: row.role === 'admin' ? 'info' : 'default' }, { default: () => (row.role === 'admin' ? t('chatPermissions.chatAdmin') : t('chatPermissions.member')) }),
  },
  {
    key: 'tags',
    title: t('chatPermissions.tags'),
    render: (row) => h(NSpace, { size: 4 }, { default: () => row.tags.map((tag) => h(NTag, { size: 'small', bordered: false }, { default: () => tag })) }),
  },
  {
    key: 'blocked',
    title: t('chatPermissions.blocked'),
    width: 90,
    render: (row) => (row.blocked ? h(NTag, { size: 'small', bordered: false, type: 'error' }, { default: () => t('chatPermissions.blockedTag') }) : null),
  },
  { key: 'note', title: t('chatPermissions.note'), ellipsis: { tooltip: true } },
  { key: 'joinedAt', title: t('chatPermissions.joinedAt'), width: 150, render: (row) => h('span', { class: 'muted' }, formatTime(row.joinedAt)) },
  {
    key: 'actions',
    title: t('common.actions'),
    width: 80,
    fixed: 'right' as const,
    render: (row) => h(NSpace, { size: 2, wrap: false }, {
      default: () => [
        h(IconAction, { icon: CreateOutline, label: t('common.edit'), onClick: () => (editing.value = { ...row, tags: [...row.tags], isNew: false }) }),
        h(IconAction, { icon: TrashOutline, label: t('common.delete'), type: 'error', onClick: () => removeMember(row) }),
      ],
    }),
  },
])

// ---- rules ----

const draft = ref<{ feature: string; effect: 'off' | 'tags'; tags: string[] }>({ feature: '', effect: 'tags', tags: [] })

async function addRule() {
  if (!channel.value) return
  try {
    await call('permissions.rules.create', { bot: props.bot.id, channel: channel.value, rule: { ...draft.value, feature: draft.value.feature.trim() } })
    draft.value = { feature: '', effect: 'tags', tags: [] }
    await Promise.all([loadChat(), loadChannels()])
  } catch (error) {
    message.error((error as Error).message)
  }
}

async function removeRule(rule: ChatRule) {
  try {
    await call('permissions.rules.delete', { bot: props.bot.id, id: rule.id })
    await loadChat()
  } catch (error) {
    message.error((error as Error).message)
  }
}

function describeRule(rule: ChatRule) {
  const feature = rule.feature === '*' ? t('chatPermissions.everything') : `“${rule.feature}”`
  return rule.effect === 'off' ? t('chatPermissions.ruleOff', { feature }) : t('chatPermissions.ruleTags', { feature, tags: rule.tags.join('、') })
}
</script>

<template>
  <NCard :title="t('chatPermissions.title')">
    <p class="muted lead">{{ t('chatPermissions.lead') }}</p>
    <div class="row">
      <NSelect
        :value="channel ?? null"
        :options="channels"
        filterable
        tag
        class="channel"
        :placeholder="t('chatPermissions.pickChat')"
        @update:value="pickChannel"
      />
      <span class="spacer" />
      <NSwitch :value="chatCommands" @update:value="setCommands" />
      <span>{{ t('chatPermissions.commands') }}</span>
    </div>
    <p class="muted small">{{ t('chatPermissions.commandsHint') }}</p>

    <NEmpty v-if="!channel" :description="t('chatPermissions.noChat')" />
    <template v-else>
      <div class="section-head">
        <h3>{{ t('chatPermissions.members') }}</h3>
        <NButton size="small" @click="addMember">
          <template #icon><NIcon><AddOutline /></NIcon></template>
          {{ t('chatPermissions.addMember') }}
        </NButton>
      </div>
      <NDataTable size="small" :columns="memberColumns" :data="members" :loading="loading" :row-key="(row: ChatMember) => row.user" :scroll-x="760" />

      <div class="section-head">
        <h3>{{ t('chatPermissions.rules') }}</h3>
      </div>
      <p class="muted small">{{ t('chatPermissions.rulesHint') }}</p>
      <div v-for="rule in rules" :key="rule.id" class="rule">
        <span>{{ describeRule(rule) }}</span>
        <span class="spacer" />
        <IconAction :icon="TrashOutline" :label="t('common.delete')" type="error" @click="removeRule(rule)" />
      </div>
      <div class="row rule-form">
        <NInput v-model:value="draft.feature" size="small" class="feature" :placeholder="t('chatPermissions.feature')" />
        <NRadioGroup v-model:value="draft.effect" size="small">
          <NRadioButton value="tags">{{ t('chatPermissions.effectTags') }}</NRadioButton>
          <NRadioButton value="off">{{ t('chatPermissions.effectOff') }}</NRadioButton>
        </NRadioGroup>
        <NDynamicTags v-if="draft.effect === 'tags'" v-model:value="draft.tags" size="small" />
        <NButton size="small" type="primary" :disabled="!draft.feature.trim() || (draft.effect === 'tags' && !draft.tags.length)" @click="addRule">
          {{ t('chatPermissions.addRule') }}
        </NButton>
      </div>
    </template>

    <NModal
      :show="!!editing"
      preset="card"
      class="member-modal"
      :title="editing?.isNew ? t('chatPermissions.addMember') : t('chatPermissions.editMember', { user: editing?.user })"
      @update:show="(value: boolean) => !value && (editing = undefined)"
    >
      <NForm v-if="editing" label-placement="top">
        <NFormItem v-if="editing.isNew" :label="t('chatPermissions.user')">
          <NInput v-model:value="editing.user" :placeholder="t('chatPermissions.userHint')" />
        </NFormItem>
        <NFormItem :label="t('chatPermissions.role')">
          <NRadioGroup v-model:value="editing.role">
            <NRadioButton value="member">{{ t('chatPermissions.member') }}</NRadioButton>
            <NRadioButton value="admin">{{ t('chatPermissions.chatAdmin') }}</NRadioButton>
          </NRadioGroup>
        </NFormItem>
        <NFormItem :label="t('chatPermissions.tags')">
          <NDynamicTags v-model:value="editing.tags" />
        </NFormItem>
        <NFormItem :label="t('chatPermissions.blocked')">
          <NSwitch v-model:value="editing.blocked" />
        </NFormItem>
        <NFormItem :label="t('chatPermissions.note')">
          <NInput v-model:value="editing.note" />
        </NFormItem>
      </NForm>
      <NAlert v-if="editing?.blocked" type="warning" :show-icon="false">{{ t('chatPermissions.blockedHint') }}</NAlert>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="editing = undefined">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" :disabled="!editing?.user.trim()" @click="saveMember">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </NCard>
</template>

<style scoped>
.lead {
  margin: 0 0 12px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.channel {
  flex: 0 1 320px;
  min-width: 200px;
}

.spacer {
  flex: 1;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 18px 0 8px;
}

.section-head h3 {
  margin: 0;
  font-size: 14px;
}

.rule {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.08);
  margin-bottom: 6px;
  font-size: 13px;
}

.rule-form {
  margin-top: 8px;
}

.feature {
  width: 180px;
}

.muted {
  opacity: 0.65;
}

.small {
  font-size: 12px;
}
</style>

<style>
.member-modal {
  width: min(480px, 92vw);
}
</style>
