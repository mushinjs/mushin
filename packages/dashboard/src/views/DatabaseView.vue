<script setup lang="ts">
import { Alert, Button, DataTable, type DataTableColumn, type DataTableSortState, Dropdown, Empty, Input, Modal, Pagination, Select, Spin, TabPane, Tabs, Tag, useConfirm, useToast } from '@mushinjs/ui'
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { call, on } from '../api'
import BrowserStorage from '../components/BrowserStorage.vue'
import PageHeader from '../components/PageHeader.vue'
import IconAction from '../components/IconAction.vue'
import { useAgentSceneStore } from '../stores/agentScene'
import type { AppPlugin, DatabaseStatus, DatabaseTable } from '../types'
import { formatBytes, pretty } from '../utils'

const { t } = useI18n()
const message = useToast()
const dialog = useConfirm()
const route = useRoute()
const router = useRouter()
const scene = useAgentSceneStore()

/** `server` for the plugins' tables, `browser` for what this browser keeps. */
const source = computed(() => (route.query.source === 'browser' ? 'browser' : 'server'))

function setSource(next: string) {
  void router.replace({ query: next === 'browser' ? { source: 'browser' } : { table: route.query.table } })
}

const available = ref<boolean>()
const status = ref<DatabaseStatus>()
const tables = ref<DatabaseTable[]>([])
const loading = ref(true)

async function refresh() {
  try {
    const plugins = await call<AppPlugin[]>('plugins.list')
    available.value = plugins.some((plugin) => plugin.package === '@mushinjs/plugin-database' && plugin.status === 'active')
    if (!available.value) return
    const [nextStatus, nextTables] = await Promise.all([call<DatabaseStatus>('database.status'), call<DatabaseTable[]>('database.tables')])
    status.value = nextStatus
    tables.value = nextTables
    if (!selected.value && nextTables.length) selectTable(nextTables[0].name)
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(refresh)
const offs = [on('manager/changed', refresh)]
onBeforeUnmount(() => {
  offs.forEach((off) => off())
  scene.publish(undefined)
})

/** Tables grouped by the plugin prefix of their names. */
const groups = computed(() => {
  const map = new Map<string, DatabaseTable[]>()
  for (const table of tables.value) {
    const list = map.get(table.group) ?? []
    list.push(table)
    map.set(table.group, list)
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
})

// ---- the open table ----

const selected = computed(() => (typeof route.query.table === 'string' ? route.query.table : ''))
const table = computed(() => tables.value.find((item) => item.name === selected.value))
const rows = ref<Record<string, unknown>[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)
const sort = ref<{ column: string; order: 'asc' | 'desc' }>()
const filters = ref<Record<string, string>>({})
const loadingRows = ref(false)

function selectTable(name: string) {
  void router.replace({ query: { ...route.query, table: name } })
}

watch(selected, () => {
  page.value = 1
  sort.value = undefined
  filters.value = {}
  void loadRows()
})

watch([table, source], ([value]) => {
  scene.publish(value && source.value === 'server' ? { label: value.name, state: { table: value.name, rows: value.count }, resource: `table:${value.name}` } : undefined)
}, { immediate: true })

async function loadRows() {
  if (!selected.value || !available.value) return
  loadingRows.value = true
  try {
    const result = await call<{ rows: Record<string, unknown>[]; total: number }>('database.rows', {
      table: selected.value,
      offset: (page.value - 1) * pageSize.value,
      limit: pageSize.value,
      ...(sort.value ? { sort: sort.value } : {}),
      ...(Object.keys(filters.value).length ? { filter: filters.value } : {}),
    })
    rows.value = result.rows
    total.value = result.total
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loadingRows.value = false
  }
}

watch(available, (value) => value && selected.value && loadRows())

// ---- filters ----

const filterColumn = ref<string | null>(null)
const filterText = ref('')
const filterOptions = computed(() => (table.value?.columns ?? [])
  .filter((column) => !['json', 'list', 'binary', 'timestamp', 'date', 'time'].includes(column.type))
  .map((column) => ({ label: column.name, value: column.name })))

function addFilter() {
  if (!filterColumn.value || filterText.value === '') return
  filters.value = { ...filters.value, [filterColumn.value]: filterText.value }
  filterText.value = ''
  page.value = 1
  void loadRows()
}

function removeFilter(name: string) {
  const { [name]: _removed, ...rest } = filters.value
  filters.value = rest
  page.value = 1
  void loadRows()
}

// ---- cells, editing and deleting ----

const viewing = ref<{ title: string; text: string }>()
const editing = ref<{ key: Record<string, unknown>; text: string }>()
const saving = ref(false)

function keyOf(row: Record<string, unknown>) {
  return Object.fromEntries((table.value?.primary ?? []).map((name) => [name, row[name]]))
}

function cell(value: unknown) {
  if (value === null || value === undefined) return h('span', { class: 'muted' }, 'null')
  if (typeof value === 'object') {
    const text = JSON.stringify(value)
    return h('a', { class: 'json-cell mono', onClick: () => (viewing.value = { title: t('database.json'), text: pretty(value) }) }, text.length > 60 ? `${text.slice(0, 60)}…` : text)
  }
  if (typeof value === 'boolean') return h(Tag, { size: 'small', type: value ? 'success' : 'default' }, { default: () => String(value) })
  const text = String(value)
  return h('span', { class: 'mono', title: text.length > 80 ? text : undefined }, text.length > 80 ? `${text.slice(0, 80)}…` : text)
}

function openEdit(row: Record<string, unknown>) {
  const primary = table.value?.primary ?? []
  const data = Object.fromEntries(Object.entries(row).filter(([name]) => !primary.includes(name)))
  editing.value = { key: keyOf(row), text: JSON.stringify(data, null, 2) }
}

async function saveEdit() {
  if (!editing.value || !table.value) return
  let data: Record<string, unknown>
  try {
    data = JSON.parse(editing.value.text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(t('database.notObject'))
  } catch (error) {
    message.error((error as Error).message)
    return
  }
  saving.value = true
  try {
    await call('database.update', { table: table.value.name, key: editing.value.key, data })
    editing.value = undefined
    message.success(t('common.saved'))
    await loadRows()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

function removeRow(row: Record<string, unknown>) {
  if (!table.value) return
  const name = table.value.name
  dialog.warning({
    title: t('database.deleteRow'),
    content: t('database.deleteHint', { key: JSON.stringify(keyOf(row)) }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await call('database.remove', { table: name, keys: [keyOf(row)] })
        message.success(t('common.deleted'))
        await Promise.all([loadRows(), refresh()])
      } catch (error) {
        message.error((error as Error).message)
      }
    },
  })
}

const columns = computed<DataTableColumn<Record<string, unknown>>[]>(() => {
  if (!table.value) return []
  return [
    ...table.value.columns.map((column) => ({
      key: column.name,
      title: () => h('span', { class: 'column-title' }, [column.primary ? h('span', { class: 'key' }, '🔑 ') : null, column.name, h('span', { class: 'muted type' }, ` ${column.type}`)]),
      sorter: !['json', 'list', 'binary'].includes(column.type) ? true : undefined,
      sortOrder: sort.value?.column === column.name ? (sort.value.order === 'asc' ? 'ascend' as const : 'descend' as const) : false as const,
      ellipsis: false,
      minWidth: 100,
      render: (row: Record<string, unknown>) => cell(row[column.name]),
    })),
    {
      key: 'actions',
      title: t('common.actions'),
      width: 90,
      fixed: 'right' as const,
      render: (row: Record<string, unknown>) => h('div', { class: 'flex gap-[2px] items-center' }, [
        h(IconAction, { icon: 'i-lucide-pencil', label: t('common.edit'), onClick: () => openEdit(row) }),
        h(IconAction, { icon: 'i-lucide-trash-2', label: t('common.delete'), type: 'error', onClick: () => removeRow(row) }),
      ]),
    },
  ]
})

function onSort(next: DataTableSortState) {
  sort.value = next.order ? { column: String(next.columnKey), order: next.order === 'ascend' ? 'asc' : 'desc' } : undefined
  page.value = 1
  void loadRows()
}

const PAGE_SIZES = [20, 50, 100, 200]

function setPage(value: number) {
  page.value = value
  void loadRows()
}

function setPageSize(value: number) {
  pageSize.value = value
  page.value = 1
  void loadRows()
}

// ---- export and backup ----

const exportOptions = [{ label: 'CSV', key: 'csv' }, { label: 'JSON', key: 'json' }]

async function exportTable(format: string) {
  if (!table.value) return
  try {
    const result = await call<{ filename: string; content: string; truncated: boolean }>('database.export', {
      table: table.value.name,
      format,
      ...(Object.keys(filters.value).length ? { filter: filters.value } : {}),
    })
    const url = URL.createObjectURL(new Blob([result.content], { type: format === 'csv' ? 'text/csv' : 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = result.filename
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    if (result.truncated) message.warning(t('database.truncated'))
  } catch (error) {
    message.error((error as Error).message)
  }
}

// ---- flow tables ----

const FIELD_TYPES = ['text', 'number', 'integer', 'boolean', 'json'] as const
type FieldType = typeof FIELD_TYPES[number]
const FLOW_PREFIX = 'flow_'
const fieldTypeOptions = computed(() => FIELD_TYPES.map((type) => ({ value: type, label: t(`database.fieldType.${type}`) })))

/** The table being created or given more fields; `existing` fields cannot change. */
const designing = ref<{ name: string; isNew: boolean; existing: { name: string; type: string }[]; fields: { name: string; type: FieldType }[] }>()
const flowTable = computed(() => (table.value?.name.startsWith(FLOW_PREFIX) ? table.value.name.slice(FLOW_PREFIX.length) : undefined))

/** A flow table column's type in the words the design form uses. */
const COLUMN_FIELD_TYPES: Record<string, FieldType> = { string: 'text', text: 'text', double: 'number', integer: 'integer', boolean: 'boolean', json: 'json' }
const columnTypeLabel = (type: string) => (COLUMN_FIELD_TYPES[type] ? t(`database.fieldType.${COLUMN_FIELD_TYPES[type]}`) : type)

function newFlowTable() {
  designing.value = { name: '', isNew: true, existing: [], fields: [{ name: '', type: 'text' }] }
}

function addFields() {
  if (!table.value || !flowTable.value) return
  const builtin = ['id', 'createdAt', 'updatedAt']
  designing.value = {
    name: flowTable.value,
    isNew: false,
    existing: table.value.columns.filter((column) => !builtin.includes(column.name)).map((column) => ({ name: column.name, type: columnTypeLabel(column.type) })),
    fields: [{ name: '', type: 'text' }],
  }
}

async function saveDesign() {
  if (!designing.value) return
  const { name, fields, isNew } = designing.value
  saving.value = true
  try {
    await call('flows.tables.define', { name: name.trim(), fields: fields.filter((item) => item.name.trim()).map((item) => ({ ...item, name: item.name.trim() })) })
    designing.value = undefined
    message.success(t('common.saved'))
    await refresh()
    if (isNew) selectTable(`${FLOW_PREFIX}${name.trim()}`)
    else await loadRows()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

function dropFlowTable() {
  const name = flowTable.value
  if (!name) return
  dialog.warning({
    title: t('database.dropTable'),
    content: t('database.dropHint', { name }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await call('flows.tables.drop', { name })
        message.success(t('common.deleted'))
        void router.replace({ query: { ...route.query, table: undefined } })
        await refresh()
      } catch (error) {
        message.error((error as Error).message)
      }
    },
  })
}

const backingUp = ref(false)

async function backup() {
  backingUp.value = true
  try {
    const result = await call<{ path: string; size: number }>('database.backup')
    message.success(t('database.backedUp', { path: result.path, size: formatBytes(result.size) }))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    backingUp.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader :title="t('nav.database')" :lead="source === 'browser' ? t('database.browser.lead') : t('database.lead')">
      <div v-if="available && source === 'server'" class="flex flex-wrap gap-x-3 gap-y-2 items-center">
        <Button icon="i-lucide-plus" @click="newFlowTable">
          {{ t('database.newFlowTable') }}
        </Button>
        <Tag v-if="status">
          {{ status.driver === 'sqlite' ? 'SQLite' : t('database.memory') }}
          <template v-if="status.path"> · <span class="mono">{{ status.path }}</span> · {{ formatBytes(status.size ?? 0) }}</template>
        </Tag>
        <Button v-if="status?.driver === 'sqlite'" :loading="backingUp" icon="i-lucide-archive" @click="backup">
          {{ t('database.backup') }}
        </Button>
      </div>
    </PageHeader>

    <Tabs :value="source" type="line" @update:value="setSource">
      <TabPane name="server" :tab="t('database.server')">
        <Spin :show="loading">
          <Alert v-if="available === false" type="warning" :title="t('database.unavailable')">
            {{ t('database.unavailableHint') }}
            <RouterLink to="/plugins">{{ t('nav.plugins') }}</RouterLink>
          </Alert>
          <Empty v-else-if="available && !tables.length" :description="t('database.noTables')" />
          <div v-else-if="available" class="layout">
            <nav class="tables">
              <div v-for="[group, list] in groups" :key="group" class="group">
                <div class="group-name muted">{{ group }}</div>
                <a
                  v-for="item in list"
                  :key="item.name"
                  class="table-link hover-row"
                  :class="{ active: item.name === selected }"
                  @click="selectTable(item.name)"
                >
                  <span class="mono">{{ item.name }}</span>
                  <span class="muted count">{{ item.count }}</span>
                </a>
              </div>
            </nav>

            <section v-if="table" class="rows">
              <div class="toolbar">
                <Select v-model:value="filterColumn" :options="filterOptions" :placeholder="t('database.column')" size="small" class="filter-column" clearable />
                <Input v-model:value="filterText" size="small" :placeholder="t('database.value')" :title="t('database.filterHint')" class="filter-text" @keyup.enter="addFilter" />
                <Button size="small" :disabled="!filterColumn || filterText === ''" @click="addFilter">{{ t('database.filter') }}</Button>
                <Tag v-for="(value, name) in filters" :key="name" size="small" closable @close="removeFilter(String(name))">
                  <span class="mono">{{ name }}</span>: {{ value }}
                </Tag>
                <div class="spacer" />
                <span class="muted">{{ t('database.total', { count: total }) }}</span>
                <IconAction icon="i-lucide-refresh-cw" :label="t('common.reload')" @click="loadRows" />
                <template v-if="flowTable">
                  <Button size="small" icon="i-lucide-plus" @click="addFields">
                    {{ t('database.addFields') }}
                  </Button>
                  <IconAction icon="i-lucide-trash-2" :label="t('database.dropTable')" type="error" @click="dropFlowTable" />
                </template>
                <Dropdown :options="exportOptions" @select="exportTable">
                  <Button size="small" icon="i-lucide-download">
                    {{ t('database.export') }}
                  </Button>
                </Dropdown>
              </div>
              <DataTable
                size="small"
                :columns="columns"
                :data="rows"
                :loading="loadingRows"
                :row-key="(row: Record<string, unknown>) => JSON.stringify(keyOf(row))"
                :scroll-x="Math.max(600, (table.columns.length + 1) * 140)"
                :max-height="'calc(100vh - 300px)'"
                @update:sorter="onSort"
              />
              <Pagination
                v-if="total > PAGE_SIZES[0]"
                :page="page"
                :page-size="pageSize"
                :page-sizes="PAGE_SIZES"
                :item-count="total"
                size="small"
                class="pager"
                @update:page="setPage"
                @update:page-size="setPageSize"
              />
            </section>
          </div>
        </Spin>
      </TabPane>
      <TabPane name="browser" :tab="t('database.browser.tab')">
        <BrowserStorage v-if="source === 'browser'" />
      </TabPane>
    </Tabs>

    <Modal
      :show="!!designing"
      class="design-modal"
      :title="designing?.isNew ? t('database.newFlowTable') : t('database.addFieldsTo', { name: designing?.name })"
      @update:show="(value: boolean) => !value && (designing = undefined)"
    >
      <template v-if="designing">
        <p class="muted">{{ t('database.flowTableHint') }}</p>
        <Input v-if="designing.isNew" v-model:value="designing.name" :placeholder="t('database.tableName')" class="design-name">
          <template #prefix><span class="mono muted">flow_</span></template>
        </Input>
        <div v-for="item in designing.existing" :key="item.name" class="design-row">
          <Input :value="item.name" disabled size="small" />
          <Input :value="item.type" disabled size="small" class="design-type" />
          <span class="design-gap" />
        </div>
        <div v-for="(item, index) in designing.fields" :key="index" class="design-row">
          <Input v-model:value="item.name" size="small" :placeholder="t('database.fieldName')" />
          <Select v-model:value="item.type" size="small" :options="fieldTypeOptions" class="design-type" />
          <IconAction icon="i-lucide-x" :label="t('common.delete')" @click="designing.fields.splice(index, 1)" />
        </div>
        <Button dashed size="small" icon="i-lucide-plus" @click="designing.fields.push({ name: '', type: 'text' })">
          {{ t('database.addField') }}
        </Button>
        <p class="muted small">{{ t('database.builtinColumns') }}</p>
      </template>
      <template #footer>
        <Button @click="designing = undefined">{{ t('common.cancel') }}</Button>
        <Button type="primary" :loading="saving" :disabled="!designing?.name.trim()" @click="saveDesign">{{ t('common.save') }}</Button>
      </template>
    </Modal>

    <Modal :show="!!viewing" :title="viewing?.title" class="json-modal" @update:show="(value: boolean) => !value && (viewing = undefined)">
      <pre class="json mono">{{ viewing?.text }}</pre>
    </Modal>

    <Modal :show="!!editing" :title="t('database.editRow')" class="json-modal" @update:show="(value: boolean) => !value && (editing = undefined)">
      <template v-if="editing">
        <p class="muted">{{ t('database.editHint', { key: JSON.stringify(editing.key) }) }}</p>
        <Input v-model:value="editing.text" type="textarea" class="mono" :autosize="{ minRows: 8, maxRows: 24 }" />
      </template>
      <template #footer>
        <Button icon="i-lucide-x" @click="editing = undefined">
          {{ t('common.cancel') }}
        </Button>
        <Button type="warning" :loading="saving" @click="saveEdit">{{ t('common.save') }}</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.tables {
  display: flex;
  flex-direction: column;
  gap: 12px;
  position: sticky;
  top: 0;
}

.group-name {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}

.table-link {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
  color: inherit;
  text-decoration: none;
}

.table-link.active {
  background: var(--row-hover);
  font-weight: 600;
}

.count {
  font-variant-numeric: tabular-nums;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.filter-column {
  width: 160px;
}

.filter-text {
  width: 200px;
}

.spacer {
  flex: 1;
}

.pager {
  justify-content: flex-end;
  margin-top: 10px;
}

:deep(.mu-table td),
:deep(.mu-table th) {
  white-space: nowrap;
}

:deep(.muted) {
  opacity: 0.65;
}

.column-title .type {
  font-size: 11px;
  font-weight: normal;
}

:deep(.json-cell) {
  cursor: pointer;
}

.json {
  margin: 0;
  max-height: 60vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.design-name {
  margin-bottom: 10px;
}

.design-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.design-type {
  width: 150px;
  flex: none;
}

.design-gap {
  width: 28px;
  flex: none;
}

@media (max-width: 800px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .tables {
    position: static;
  }
}
</style>

<style>
/* Modals render outside the page, so their width is set here rather than in the scoped styles. */
.design-modal {
  width: min(560px, 92vw);
}

.json-modal {
  width: min(720px, 92vw);
}
</style>
