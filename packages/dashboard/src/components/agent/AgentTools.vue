<script setup lang="ts">
import { Button, DataTable, type DataTableColumn, Input, Select, Tag, useToast } from '@mushin/ui'
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call, on } from '../../api'

type Policy = 'auto' | 'confirm' | 'off'

interface ToolRow {
  name: string
  description: string
  plugin: string
  risk: 'read' | 'write' | 'dangerous'
  client: boolean
  policy: Policy
  custom: boolean
}

const { t } = useI18n()
const message = useToast()
const rows = ref<ToolRow[]>([])
const loading = ref(false)
const query = ref('')
const plugin = ref<string | null>(null)
const risk = ref<string | null>(null)
const policyFilter = ref<string | null>(null)

async function refresh() {
  loading.value = true
  try {
    rows.value = await call<ToolRow[]>('agent.policy.list')
  } finally {
    loading.value = false
  }
}

let offs: (() => void)[] = []
onMounted(() => {
  refresh().catch(() => {})
  offs = ['actions/changed', 'agent/changed'].map((name) => on(name, () => refresh().catch(() => {})))
})
onBeforeUnmount(() => offs.forEach((off) => off()))

async function setPolicy(names: string[], policy: Policy | null) {
  try {
    rows.value = await call<ToolRow[]>('agent.policy.set', { policies: Object.fromEntries(names.map((name) => [name, policy])) })
  } catch (error) {
    message.error((error as Error).message)
  }
}

const filtered = computed(() => {
  const text = query.value.trim().toLowerCase()
  return rows.value.filter((row) => (!text || row.name.toLowerCase().includes(text) || row.description.toLowerCase().includes(text))
    && (!plugin.value || row.plugin === plugin.value)
    && (!risk.value || row.risk === risk.value)
    && (!policyFilter.value || row.policy === policyFilter.value))
})

const pluginOptions = computed(() => [...new Set(rows.value.map((row) => row.plugin))].sort().map((name) => ({ label: name, value: name })))
const riskOptions = ['read', 'write', 'dangerous'].map((value) => ({ label: t(`agentPage.tools.risk.${value}`), value }))
const policyOptions = (['auto', 'confirm', 'off'] as const).map((value) => ({ label: t(`agentPage.tools.policy.${value}`), value }))
const riskType = { read: 'default', write: 'info', dangerous: 'error' } as const

const columns = computed<DataTableColumn<ToolRow>[]>(() => [
  {
    title: t('agentPage.tools.name'),
    key: 'name',
    render: (row) => h('div', { class: 'tool-cell' }, [
      h('span', { class: 'mono' }, row.name),
      h('span', { class: 'tool-desc' }, row.description),
    ]),
  },
  { title: t('agentPage.tools.plugin'), key: 'plugin', width: 130, render: (row) => h('span', { class: 'mono small' }, row.plugin) },
  { title: t('agentPage.tools.riskTitle'), key: 'risk', width: 80, render: (row) => h(Tag, { size: 'small', type: riskType[row.risk] }, () => t(`agentPage.tools.risk.${row.risk}`)) },
  {
    title: t('agentPage.tools.policyTitle'),
    key: 'policy',
    width: 180,
    render: (row) => h('div', { class: 'policy-cell' }, [
      h(Select, { size: 'small', value: row.policy, options: policyOptions, style: 'width: 110px', 'onUpdate:value': (value: Policy) => setPolicy([row.name], value) }),
      row.custom ? h(Button, { size: 'tiny', quaternary: true, onClick: () => setPolicy([row.name], null) }, () => t('agentPage.tools.reset')) : null,
    ]),
  },
])
</script>

<template>
  <div class="tools-page">
    <p class="hint">{{ t('agentPage.tools.lead') }}</p>
    <div class="filters">
      <Input v-model:value="query" clearable :placeholder="t('agentPage.tools.search')" class="search">
        <template #prefix><span class="i-lucide-search" /></template>
      </Input>
      <Select v-model:value="plugin" clearable filterable :options="pluginOptions" :placeholder="t('agentPage.tools.plugin')" class="filter" />
      <Select v-model:value="risk" clearable :options="riskOptions" :placeholder="t('agentPage.tools.riskTitle')" class="filter" />
      <Select v-model:value="policyFilter" clearable :options="policyOptions" :placeholder="t('agentPage.tools.policyTitle')" class="filter" />
      <div v-if="filtered.length && (plugin || risk || query)" class="flex flex-wrap gap-x-3 gap-y-2 items-center bulk">
        <span class="hint small">{{ t('agentPage.tools.bulk', { count: filtered.length }) }}</span>
        <Button v-for="option in policyOptions" :key="option.value" size="small" @click="setPolicy(filtered.map((row) => row.name), option.value)">{{ option.label }}</Button>
      </div>
    </div>
    <DataTable :columns="columns" :data="filtered" :loading="loading" :row-key="(row: ToolRow) => row.name" size="small" :max-height="560" />
    <p class="hint small">{{ t('agentPage.tools.note') }}</p>
  </div>
</template>

<style scoped>
.hint {
  opacity: 0.65;
}

.small {
  font-size: 12px;
}

.filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 12px;
}

.search {
  width: 240px;
}

.filter {
  width: 170px;
}

.bulk {
  align-items: center;
}

:deep(.tool-cell) {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

:deep(.tool-desc) {
  font-size: 12px;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

:deep(.policy-cell) {
  display: flex;
  gap: 4px;
  align-items: center;
}

:deep(.small) {
  font-size: 12px;
}
</style>
