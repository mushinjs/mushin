<script setup lang="ts">
import { Alert, Button, Card, DataTable, type DataTableColumn, Form, FormItem, Input, Tag, TagsInput, Toggle, useToast } from '@mushin/ui'
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { call, on } from '../api'
import { useDataStore } from '../stores/data'
import type { Bot, CommandEntry, CommandList, CommandSource } from '../types'

const props = defineProps<{ bot: Bot }>()
const { t } = useI18n()
const data = useDataStore()
const message = useToast()

const prefixes = ref<string[]>([])
const help = ref(true)
const helpTitle = ref('')
const helpByRole = ref(false)
const saving = ref(false)
const list = ref<CommandList>({ commands: [], conflicts: [] })

watch(() => props.bot.id, () => {
  const settings = props.bot.commands ?? {}
  prefixes.value = settings.prefixes?.length ? [...settings.prefixes] : ['/']
  help.value = settings.help !== false
  helpTitle.value = settings.helpTitle ?? ''
  helpByRole.value = !!settings.helpByRole
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
      commands: { prefixes: prefixes.value.filter(Boolean), help: help.value, helpTitle: helpTitle.value, helpByRole: helpByRole.value },
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
    render: (row: CommandEntry) => h('div', { class: 'flex flex-wrap gap-[4px] items-center' }, [
      ...(row.permission === 'admin' || row.role === 'admin' ? [h(Tag, { size: 'small', type: 'warning' }, () => t('bot.adminOnly'))] : []),
      ...(row.permission === 'master' || row.role === 'master' ? [h(Tag, { size: 'small', type: 'error' }, () => t('bot.masterOnly'))] : []),
      ...(row.hidden ? [h(Tag, { size: 'small' }, () => t('bot.hiddenFromHelp'))] : []),
    ]),
  },
])
</script>

<template>
  <div class="flex flex-col gap-[16px]">
    <Card :title="t('bot.commandList')">
      <Alert v-for="item in list.conflicts" :key="item.name" type="warning" :show-icon="false" class="conflict">
        {{ t('bot.commandConflict', { name: `${prefix}${item.name}`, first: sourceLabel(item.sources[0]), sources: item.sources.slice(1).map(sourceLabel).join('、') }) }}
      </Alert>
      <DataTable :columns="columns" :data="list.commands" :bordered="false" size="small" :row-key="(row: CommandEntry) => `${row.source.kind}:${row.source.id}:${row.source.nodeId ?? ''}:${row.name}`" />
      <p class="muted small hint">{{ t('bot.commandListHint') }}</p>
    </Card>

    <Card :title="t('bot.commandSettings')">
      <Form>
        <FormItem :label="t('bot.prefixes')" :feedback="t('bot.prefixesHint')">
          <TagsInput v-model:value="prefixes" />
        </FormItem>
        <FormItem :label="t('bot.helpCommand')" :feedback="t('bot.helpCommandHint')" label-placement="left">
          <Toggle v-model:value="help" />
        </FormItem>
        <FormItem v-if="help" :label="t('bot.helpTitle')">
          <Input v-model:value="helpTitle" :placeholder="t('bot.helpTitlePlaceholder')" />
        </FormItem>
        <FormItem v-if="help" :label="t('bot.helpByRole')" :feedback="t('bot.helpByRoleHint')" label-placement="left">
          <Toggle v-model:value="helpByRole" />
        </FormItem>
        <p class="muted small">
          {{ t('bot.adminsMoved') }}
          <RouterLink :to="`/bots/${bot.id}/permissions`">{{ t('bot.openPermissions') }}</RouterLink>
        </p>
      </Form>
      <div class="flex flex-wrap gap-x-3 gap-y-2 items-center justify-end">
        <Button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</Button>
      </div>
    </Card>
  </div>
</template>

<style scoped>
.conflict {
  margin-bottom: 12px;
}

.hint {
  margin-top: 12px;
}

:deep(.source-link) {
  color: var(--primary);
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
  color: var(--bad);
}
</style>
