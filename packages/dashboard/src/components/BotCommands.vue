<script setup lang="ts">
import { NAlert, NButton, NCard, NDataTable, NDynamicTags, NForm, NFormItem, NInput, NSpace, NSwitch, NTag, useMessage } from 'naive-ui'
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { call, on } from '../api'
import { useDataStore } from '../stores/data'
import type { Bot, CommandEntry, CommandList, CommandSource } from '../types'

const props = defineProps<{ bot: Bot }>()
const { t } = useI18n()
const data = useDataStore()
const message = useMessage()

const prefixes = ref<string[]>([])
const help = ref(true)
const helpTitle = ref('')
const admins = ref<string[]>([])
const saving = ref(false)
const list = ref<CommandList>({ commands: [], conflicts: [] })

watch(() => props.bot.id, () => {
  const settings = props.bot.commands ?? {}
  prefixes.value = settings.prefixes?.length ? [...settings.prefixes] : ['/']
  help.value = settings.help !== false
  helpTitle.value = settings.helpTitle ?? ''
  admins.value = [...(settings.admins ?? [])]
}, { immediate: true })

async function refresh() {
  try {
    list.value = await call<CommandList>('commands.list', { bot: props.bot.id })
  } catch (error) {
    message.error((error as Error).message)
  }
}

onMounted(refresh)
watch(() => props.bot.id, refresh)
const offs = [on('flows/changed', refresh), on('bots/changed', refresh)]
onBeforeUnmount(() => offs.forEach((off) => off()))

async function save() {
  saving.value = true
  try {
    await call('bots.update', {
      id: props.bot.id,
      commands: { prefixes: prefixes.value.filter(Boolean), help: help.value, helpTitle: helpTitle.value, admins: admins.value.filter(Boolean) },
    })
    message.success(t('common.saved'))
    await data.refreshBots()
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

const prefix = computed(() => props.bot.commands?.prefixes?.[0] || '/')
const conflicted = computed(() => new Set(list.value.conflicts.map((item) => item.name.toLowerCase())))

function sourceLabel(source: CommandSource) {
  if (source.kind === 'flow') return t('bot.sourceFlow', { name: source.name })
  if (source.kind === 'plugin') return t('bot.sourcePlugin', { name: source.name })
  return t('bot.sourceBuiltin')
}

const columns = computed(() => [
  {
    title: t('bot.colCommand'),
    key: 'name',
    render: (row: CommandEntry) => h('div', { class: 'command-cell' }, [
      h('code', { class: { clash: [row.name, ...(row.aliases ?? [])].some((name) => conflicted.value.has(name.toLowerCase())) } }, `${prefix.value}${row.name}${row.usage ? ` ${row.usage}` : ''}`),
      ...(row.aliases?.length ? [h('span', { class: 'muted small' }, row.aliases.map((alias) => `${prefix.value}${alias}`).join('、'))] : []),
    ]),
  },
  { title: t('bot.colDescription'), key: 'description', render: (row: CommandEntry) => row.description || '—' },
  {
    title: t('bot.colSource'),
    key: 'source',
    render: (row: CommandEntry) => (row.source.kind === 'flow'
      ? h(RouterLink, { to: `/flows/${row.source.id}`, class: 'source-link' }, () => sourceLabel(row.source))
      : sourceLabel(row.source)),
  },
  {
    title: '',
    key: 'tags',
    render: (row: CommandEntry) => h(NSpace, { size: 4 }, () => [
      ...(row.permission === 'admin' ? [h(NTag, { size: 'small', type: 'warning', bordered: false }, () => t('bot.adminOnly'))] : []),
      ...(row.hidden ? [h(NTag, { size: 'small', bordered: false }, () => t('bot.hiddenFromHelp'))] : []),
    ]),
  },
])
</script>

<template>
  <NSpace vertical :size="16">
    <NCard :title="t('bot.commandList')">
      <NAlert v-for="item in list.conflicts" :key="item.name" type="warning" :show-icon="false" class="conflict">
        {{ t('bot.commandConflict', { name: `${prefix}${item.name}`, sources: item.sources.map(sourceLabel).join('、') }) }}
      </NAlert>
      <NDataTable :columns="columns" :data="list.commands" :bordered="false" size="small" :row-key="(row: CommandEntry) => `${row.source.kind}:${row.source.id}:${row.source.nodeId ?? ''}:${row.name}`" />
      <p class="muted small hint">{{ t('bot.commandListHint') }}</p>
    </NCard>

    <NCard :title="t('bot.commandSettings')">
      <NForm label-placement="top">
        <NFormItem :label="t('bot.prefixes')" :feedback="t('bot.prefixesHint')">
          <NDynamicTags v-model:value="prefixes" />
        </NFormItem>
        <NFormItem :label="t('bot.helpCommand')" :feedback="t('bot.helpCommandHint')" label-placement="left">
          <NSwitch v-model:value="help" />
        </NFormItem>
        <NFormItem v-if="help" :label="t('bot.helpTitle')">
          <NInput v-model:value="helpTitle" :placeholder="t('bot.helpTitlePlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('bot.admins')" :feedback="t('bot.adminsHint')">
          <NDynamicTags v-model:value="admins" />
        </NFormItem>
      </NForm>
      <NSpace justify="end">
        <NButton type="primary" :loading="saving" @click="save">{{ t('common.save') }}</NButton>
      </NSpace>
    </NCard>
  </NSpace>
</template>

<style scoped>
.conflict {
  margin-bottom: 12px;
}

.hint {
  margin-top: 12px;
}

:deep(.source-link) {
  color: #2080f0;
  text-decoration: none;
}

:deep(.source-link:hover) {
  text-decoration: underline;
}

:deep(.muted) {
  opacity: 0.65;
}

:deep(.small) {
  font-size: 12px;
}

:deep(.command-cell) {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

:deep(.command-cell code.clash) {
  color: #d03050;
}
</style>
