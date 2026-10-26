<script setup lang="ts">
import { ArchiveOutline, CloseOutline, CreateOutline, DownloadOutline, RefreshOutline, TrashOutline } from '@vicons/ionicons5'
import {
  type DataTableColumns, type DataTableSortState, NAlert, NButton, NDataTable, NDropdown, NEmpty, NIcon, NInput, NModal, NSelect, NSpace, NSpin, NTag,
  useDialog, useMessage,
} from 'naive-ui'
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { call, on } from '../api'
import IconAction from '../components/IconAction.vue'
import { useAgentSceneStore } from '../stores/agentScene'
import type { AppPlugin, DatabaseStatus, DatabaseTable } from '../types'
import { formatBytes, pretty } from '../utils'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const route = useRoute()
const router = useRouter()
const scene = useAgentSceneStore()

const available = ref<boolean>()
const status = ref<DatabaseStatus>()
const tables = ref<DatabaseTable[]>([])
const loading = ref(true)

async function refresh() {
  try {
    const plugins = await call<AppPlugin[]>('plugins.list')
    available.value = plugins.some((plugin) => plugin.package === '@mushin/plugin-database' && plugin.status === 'active')
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

watch(table, (value) => {
  scene.publish(value ? { label: value.name, state: { table: value.name, rows: value.count }, resource: `table:${value.name}` } : undefined)
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
  if (typeof value === 'boolean') return h(NTag, { size: 'small', bordered: false, type: value ? 'success' : 'default' }, { default: () => String(value) })
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

const columns = computed<DataTableColumns<Record<string, unknown>>>(() => {
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
      render: (row: Record<string, unknown>) => h(NSpace, { size: 2, wrap: false }, {
        default: () => [
          h(IconAction, { icon: CreateOutline, label: t('common.edit'), onClick: () => openEdit(row) }),
          h(IconAction, { icon: TrashOutline, label: t('common.delete'), type: 'error', onClick: () => removeRow(row) }),
        ],
      }),
    },
  ]
})

function onSort(state: DataTableSortState | DataTableSortState[] | null) {
  const next = Array.isArray(state) ? state[0] : state
  sort.value = next?.order ? { column: String(next.columnKey), order: next.order === 'ascend' ? 'asc' : 'desc' } : undefined
  page.value = 1
  void loadRows()
}

const pagination = computed(() => ({
  page: page.value,
  pageSize: pageSize.value,
  itemCount: total.value,
  showSizePicker: true,
  pageSizes: [20, 50, 100, 200],
  onUpdatePage: (value: number) => {
    page.value = value
    void loadRows()
  },
  onUpdatePageSize: (value: number) => {
    pageSize.value = value
    page.value = 1
    void loadRows()
  },
}))

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
    <div class="page-header">
      <div>
        <h1>{{ t('nav.database') }}</h1>
        <p class="page-lead">{{ t('database.lead') }}</p>
      </div>
      <NSpace v-if="available" align="center">
        <NTag v-if="status" :bordered="false">
          {{ status.driver === 'sqlite' ? 'SQLite' : t('database.memory') }}
          <template v-if="status.path"> · <span class="mono">{{ status.path }}</span> · {{ formatBytes(status.size ?? 0) }}</template>
        </NTag>
        <NButton v-if="status?.driver === 'sqlite'" :loading="backingUp" @click="backup">
          <template #icon><NIcon><ArchiveOutline /></NIcon></template>
          {{ t('database.backup') }}
        </NButton>
      </NSpace>
    </div>

    <NSpin :show="loading">
      <NAlert v-if="available === false" type="warning" :title="t('database.unavailable')">
        {{ t('database.unavailableHint') }}
        <RouterLink to="/plugins">{{ t('nav.plugins') }}</RouterLink>
      </NAlert>
      <NEmpty v-else-if="available && !tables.length" :description="t('database.noTables')" />
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
            <NSelect v-model:value="filterColumn" :options="filterOptions" :placeholder="t('database.column')" size="small" class="filter-column" clearable />
            <NInput v-model:value="filterText" size="small" :placeholder="t('database.value')" :title="t('database.filterHint')" class="filter-text" @keyup.enter="addFilter" />
            <NButton size="small" :disabled="!filterColumn || filterText === ''" @click="addFilter">{{ t('database.filter') }}</NButton>
            <NTag v-for="(value, name) in filters" :key="name" size="small" closable @close="removeFilter(String(name))">
              <span class="mono">{{ name }}</span>: {{ value }}
            </NTag>
            <div class="spacer" />
            <span class="muted">{{ t('database.total', { count: total }) }}</span>
            <IconAction :icon="RefreshOutline" :label="t('common.reload')" @click="loadRows" />
            <NDropdown :options="exportOptions" trigger="click" @select="exportTable">
              <NButton size="small">
                <template #icon><NIcon><DownloadOutline /></NIcon></template>
                {{ t('database.export') }}
              </NButton>
            </NDropdown>
          </div>
          <NDataTable
            remote
            size="small"
            :columns="columns"
            :data="rows"
            :loading="loadingRows"
            :pagination="pagination"
            :row-key="(row: Record<string, unknown>) => JSON.stringify(keyOf(row))"
            :scroll-x="Math.max(600, (table.columns.length + 1) * 140)"
            :max-height="'calc(100vh - 300px)'"
            @update:sorter="onSort"
          />
        </section>
      </div>
    </NSpin>

    <NModal :show="!!viewing" preset="card" :title="viewing?.title" class="json-modal" @update:show="(value: boolean) => !value && (viewing = undefined)">
      <pre class="json mono">{{ viewing?.text }}</pre>
    </NModal>

    <NModal :show="!!editing" preset="card" :title="t('database.editRow')" class="json-modal" @update:show="(value: boolean) => !value && (editing = undefined)">
      <template v-if="editing">
        <p class="muted">{{ t('database.editHint', { key: JSON.stringify(editing.key) }) }}</p>
        <NInput v-model:value="editing.text" type="textarea" class="mono" :autosize="{ minRows: 8, maxRows: 24 }" />
      </template>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="editing = undefined">
            <template #icon><NIcon><CloseOutline /></NIcon></template>
            {{ t('common.cancel') }}
          </NButton>
          <NButton type="warning" :loading="saving" @click="saveEdit">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NModal>
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

:deep(.n-data-table-td),
:deep(.n-data-table-th) {
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

.json-modal {
  width: min(720px, 92vw);
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
