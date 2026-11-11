<script setup lang="ts">
/**
 * The database page's browser tab: what this dashboard keeps in this browser, in localStorage,
 * sessionStorage and IndexedDB, to look through, change and delete.
 */
import { Alert, Button, DataTable, type DataTableColumn, Empty, Input, Modal, Pagination, Tag, Toggle, useConfirm, useToast } from '@mushinjs/ui'
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import {
  clearIdb, clearWebStorage, deleteIdb, describe, type IdbDatabaseInfo, type IdbRecord, idbSupported, jsonSafe, keyText,
  listIdb, listWebStorage, putIdb, readIdb, removeIdb, removeWebStorage, setWebStorage, type WebStorageItem, type WebStorageKind, webStorageSize,
} from '../browserStorage'
import { formatBytes } from '../utils'
import IconAction from './IconAction.vue'

const { t } = useI18n()
const message = useToast()
const dialog = useConfirm()
const route = useRoute()
const router = useRouter()

const fail = (error: unknown) => message.error((error as Error)?.message ?? String(error))

// ---- what there is ----

const webItems = ref<Record<WebStorageKind, WebStorageItem[]>>({ local: [], session: [] })
const databases = ref<IdbDatabaseInfo[]>([])

function refreshWeb() {
  webItems.value = { local: listWebStorage('local'), session: listWebStorage('session') }
}

async function refreshIdb() {
  try {
    databases.value = await listIdb()
  } catch (error) {
    fail(error)
  }
}

async function refresh() {
  refreshWeb()
  await refreshIdb()
}

/** Other tabs of the dashboard change localStorage too. */
const onStorage = (event: StorageEvent) => event.storageArea === localStorage && refreshWeb()
onMounted(() => {
  void refresh()
  window.addEventListener('storage', onStorage)
})
onBeforeUnmount(() => window.removeEventListener('storage', onStorage))

// ---- the open item: `local`, `session` or `idb:<database>/<store>` ----

const selected = computed(() => (typeof route.query.item === 'string' ? route.query.item : 'local'))
const webKind = computed<WebStorageKind | undefined>(() => (selected.value === 'local' || selected.value === 'session' ? selected.value : undefined))
const idbTarget = computed(() => {
  if (!selected.value.startsWith('idb:')) return undefined
  const rest = selected.value.slice(4)
  const at = rest.lastIndexOf('/')
  return at < 0 ? undefined : { db: rest.slice(0, at), store: rest.slice(at + 1) }
})
const idbStore = computed(() => {
  const target = idbTarget.value
  return target && databases.value.find((db) => db.name === target.db)?.stores.find((store) => store.name === target.store)
})

function select(item: string) {
  void router.replace({ query: { ...route.query, item } })
}

const PREVIEW = 80
const clip = (text: string) => (text.length > PREVIEW ? `${text.slice(0, PREVIEW)}…` : text)

// ---- localStorage and sessionStorage ----

const search = ref('')
const webRows = computed(() => {
  const list = webKind.value ? webItems.value[webKind.value] : []
  const query = search.value.trim().toLowerCase()
  return query ? list.filter((item) => item.key.toLowerCase().includes(query)) : list
})

/** The item being added (`original` empty) or changed. */
const editingWeb = ref<{ original?: string; key: string; text: string; json: boolean }>()

function prettyIfJson(value: string) {
  try {
    const parsed = JSON.parse(value)
    if (parsed !== null && typeof parsed === 'object') return { text: JSON.stringify(parsed, null, 2), json: true }
  } catch { /* plain text */ }
  return { text: value, json: false }
}

function openWeb(item?: WebStorageItem) {
  editingWeb.value = item ? { original: item.key, key: item.key, ...prettyIfJson(item.value) } : { key: '', text: '', json: false }
}

function saveWeb() {
  const editing = editingWeb.value
  const kind = webKind.value
  if (!editing || !kind) return
  const key = editing.key
  if (!key) return
  let value = editing.text
  if (editing.json) {
    try {
      value = JSON.stringify(JSON.parse(value))
    } catch (error) {
      return fail(error)
    }
  }
  if (key !== editing.original && webItems.value[kind].some((item) => item.key === key)) return fail(new Error(t('database.browser.keyTaken', { key })))
  try {
    setWebStorage(kind, key, value)
    if (editing.original !== undefined && editing.original !== key) removeWebStorage(kind, editing.original)
    editingWeb.value = undefined
    message.success(t('common.saved'))
  } catch (error) {
    fail(error)
  }
  refreshWeb()
}

function removeWeb(item: WebStorageItem) {
  const kind = webKind.value
  if (!kind) return
  dialog.warning({
    title: t('database.browser.deleteItem'),
    content: t('database.browser.deleteItemHint', { key: item.key }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      removeWebStorage(kind, item.key)
      refreshWeb()
      message.success(t('common.deleted'))
    },
  })
}

function clearWeb() {
  const kind = webKind.value
  if (!kind) return
  dialog.warning({
    title: t('database.browser.clearAll'),
    content: t('database.browser.clearWebHint', { name: kind === 'local' ? 'localStorage' : 'sessionStorage', count: webItems.value[kind].length }),
    positiveText: t('database.browser.clear'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      clearWebStorage(kind)
      refreshWeb()
      message.success(t('common.deleted'))
    },
  })
}

const webColumns = computed<DataTableColumn<WebStorageItem>[]>(() => [
  { key: 'key', title: t('database.browser.key'), minWidth: 200, render: (row) => h('span', { class: 'mono', title: row.key }, clip(row.key)) },
  { key: 'value', title: t('database.browser.value'), minWidth: 260, render: (row) => h('a', { class: 'mono value-cell', title: t('common.edit'), onClick: () => openWeb(row) }, clip(row.value) || '""') },
  { key: 'size', title: t('database.browser.size'), width: 90, render: (row) => h('span', { class: 'muted num' }, formatBytes(webStorageSize([row]))) },
  {
    key: 'actions',
    title: t('common.actions'),
    width: 90,
    fixed: 'right',
    render: (row) => h('div', { class: 'flex gap-[2px] items-center' }, [
      h(IconAction, { icon: 'i-lucide-pencil', label: t('common.edit'), onClick: () => openWeb(row) }),
      h(IconAction, { icon: 'i-lucide-trash-2', label: t('common.delete'), type: 'error', onClick: () => removeWeb(row) }),
    ]),
  },
])

// ---- IndexedDB ----

const records = ref<IdbRecord[]>([])
const page = ref(1)
const pageSize = ref(50)
const PAGE_SIZES = [20, 50, 100, 200]
const loadingRecords = ref(false)

async function loadRecords() {
  const target = idbTarget.value
  if (!target) return
  loadingRecords.value = true
  try {
    records.value = await readIdb(target.db, target.store, (page.value - 1) * pageSize.value, pageSize.value)
  } catch (error) {
    records.value = []
    fail(error)
  } finally {
    loadingRecords.value = false
  }
}

async function reloadIdb() {
  await refreshIdb()
  await loadRecords()
}

watch(selected, () => {
  page.value = 1
  search.value = ''
  records.value = []
  void loadRecords()
}, { immediate: true })

const keyPathText = (keyPath: string | string[] | null) => (keyPath === null ? t('database.browser.outOfLine') : Array.isArray(keyPath) ? keyPath.join(', ') : keyPath)

/** The record being added (`original` unset) or changed, its value as JSON. */
const editingIdb = ref<{ original?: IDBValidKey; keyText: string; text: string }>()
const viewingIdb = ref<IdbRecord>()
const saving = ref(false)

function openIdb(record?: IdbRecord) {
  if (record && !jsonSafe(record.value)) {
    viewingIdb.value = record
    return
  }
  editingIdb.value = record
    ? { original: record.key, keyText: JSON.stringify(record.key), text: JSON.stringify(record.value, null, 2) }
    : { keyText: '', text: '{}' }
}

async function saveIdb() {
  const editing = editingIdb.value
  const target = idbTarget.value
  const store = idbStore.value
  if (!editing || !target || !store) return
  let value: unknown
  let key: IDBValidKey | undefined
  try {
    value = JSON.parse(editing.text)
    if (store.keyPath === null && editing.keyText.trim()) key = JSON.parse(editing.keyText) as IDBValidKey
    if (store.keyPath === null && key === undefined && !store.autoIncrement) throw new Error(t('database.browser.keyNeeded'))
  } catch (error) {
    return fail(error)
  }
  saving.value = true
  try {
    const written = await putIdb(target.db, target.store, value, key)
    // A changed key writes a new record, so the old one goes.
    if (editing.original !== undefined && indexedDB.cmp(written, editing.original) !== 0) await removeIdb(target.db, target.store, editing.original)
    editingIdb.value = undefined
    message.success(t('common.saved'))
    await reloadIdb()
  } catch (error) {
    fail(error)
  } finally {
    saving.value = false
  }
}

function removeRecord(record: IdbRecord) {
  const target = idbTarget.value
  if (!target) return
  dialog.warning({
    title: t('database.browser.deleteRecord'),
    content: t('database.browser.deleteItemHint', { key: keyText(record.key) }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await removeIdb(target.db, target.store, record.key)
        message.success(t('common.deleted'))
        await reloadIdb()
      } catch (error) {
        fail(error)
      }
    },
  })
}

function clearStore() {
  const target = idbTarget.value
  if (!target) return
  dialog.warning({
    title: t('database.browser.clearAll'),
    content: t('database.browser.clearStoreHint', { name: target.store, count: idbStore.value?.count ?? 0 }),
    positiveText: t('database.browser.clear'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await clearIdb(target.db, target.store)
        message.success(t('common.deleted'))
        page.value = 1
        await reloadIdb()
      } catch (error) {
        fail(error)
      }
    },
  })
}

function dropDatabase(name: string) {
  dialog.warning({
    title: t('database.browser.deleteDatabase'),
    content: t('database.browser.deleteDatabaseHint', { name }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await deleteIdb(name)
        message.success(t('common.deleted'))
        if (idbTarget.value?.db === name) select('local')
        await refreshIdb()
      } catch (error) {
        fail(error)
      }
    },
  })
}

const idbColumns = computed<DataTableColumn<IdbRecord>[]>(() => [
  { key: 'key', title: t('database.browser.key'), minWidth: 180, render: (row) => h('span', { class: 'mono' }, clip(keyText(row.key))) },
  {
    key: 'value',
    title: t('database.browser.value'),
    minWidth: 280,
    render: (row) => h('a', { class: 'mono value-cell', onClick: () => openIdb(row) }, [
      jsonSafe(row.value) ? null : h(Tag, { size: 'small', class: 'mr-1' }, { default: () => t('database.browser.readOnly') }),
      clip(describe(row.value)),
    ]),
  },
  {
    key: 'actions',
    title: t('common.actions'),
    width: 90,
    fixed: 'right',
    render: (row) => h('div', { class: 'flex gap-[2px] items-center' }, [
      h(IconAction, { icon: jsonSafe(row.value) ? 'i-lucide-pencil' : 'i-lucide-eye', label: jsonSafe(row.value) ? t('common.edit') : t('database.browser.view'), onClick: () => openIdb(row) }),
      h(IconAction, { icon: 'i-lucide-trash-2', label: t('common.delete'), type: 'error', onClick: () => removeRecord(row) }),
    ]),
  },
])

function setPage(value: number) {
  page.value = value
  void loadRecords()
}

function setPageSize(value: number) {
  pageSize.value = value
  page.value = 1
  void loadRecords()
}
</script>

<template>
  <div class="layout">
    <nav class="tables">
      <div class="group">
        <div class="group-name muted">{{ t('database.browser.webStorage') }}</div>
        <a class="table-link hover-row" :class="{ active: selected === 'local' }" @click="select('local')">
          <span class="mono">localStorage</span>
          <span class="muted count">{{ webItems.local.length }}</span>
        </a>
        <a class="table-link hover-row" :class="{ active: selected === 'session' }" @click="select('session')">
          <span class="mono">sessionStorage</span>
          <span class="muted count">{{ webItems.session.length }}</span>
        </a>
      </div>
      <div v-for="db in databases" :key="db.name" class="group">
        <div class="group-name muted db-name">
          <span :title="`IndexedDB · v${db.version}`">IndexedDB · {{ db.name }}</span>
          <IconAction icon="i-lucide-trash-2" :label="t('database.browser.deleteDatabase')" type="error" @click="dropDatabase(db.name)" />
        </div>
        <a
          v-for="store in db.stores"
          :key="store.name"
          class="table-link hover-row"
          :class="{ active: idbTarget?.db === db.name && idbTarget.store === store.name }"
          @click="select(`idb:${db.name}/${store.name}`)"
        >
          <span class="mono">{{ store.name }}</span>
          <span class="muted count">{{ store.count }}</span>
        </a>
        <div v-if="!db.stores.length" class="muted small empty-db">{{ t('database.browser.noStores') }}</div>
      </div>
      <div v-if="!idbSupported()" class="muted small">{{ t('database.browser.noIdbList') }}</div>
      <div v-else-if="!databases.length" class="muted small">{{ t('database.browser.noIdb') }}</div>
    </nav>

    <section v-if="webKind" class="rows">
      <div class="toolbar">
        <Input v-model:value="search" size="small" clearable :placeholder="t('database.browser.searchKey')" class="search" />
        <div class="spacer" />
        <span class="muted">{{ t('database.browser.summary', { count: webItems[webKind].length, size: formatBytes(webStorageSize(webItems[webKind])) }) }}</span>
        <IconAction icon="i-lucide-refresh-cw" :label="t('common.reload')" @click="refreshWeb" />
        <Button size="small" icon="i-lucide-plus" @click="openWeb()">{{ t('database.browser.addItem') }}</Button>
        <IconAction icon="i-lucide-eraser" :label="t('database.browser.clearAll')" type="error" :disabled="!webItems[webKind].length" @click="clearWeb" />
      </div>
      <DataTable
        size="small"
        :columns="webColumns"
        :data="webRows"
        :row-key="(row: WebStorageItem) => row.key"
        :scroll-x="700"
        :max-height="'calc(100vh - 300px)'"
        :empty-text="t('database.browser.empty')"
      />
    </section>

    <section v-else-if="idbTarget" class="rows">
      <template v-if="idbStore">
        <div class="toolbar">
          <Tag size="small">{{ t('database.browser.keyPath') }}: <span class="mono">{{ keyPathText(idbStore.keyPath) }}</span></Tag>
          <Tag v-if="idbStore.autoIncrement" size="small">autoIncrement</Tag>
          <div class="spacer" />
          <span class="muted">{{ t('database.total', { count: idbStore.count }) }}</span>
          <IconAction icon="i-lucide-refresh-cw" :label="t('common.reload')" @click="reloadIdb" />
          <Button size="small" icon="i-lucide-plus" @click="openIdb()">{{ t('database.browser.addRecord') }}</Button>
          <IconAction icon="i-lucide-eraser" :label="t('database.browser.clearAll')" type="error" :disabled="!idbStore.count" @click="clearStore" />
        </div>
        <DataTable
          size="small"
          :columns="idbColumns"
          :data="records"
          :loading="loadingRecords"
          :row-key="(row: IdbRecord) => keyText(row.key)"
          :scroll-x="700"
          :max-height="'calc(100vh - 300px)'"
          :empty-text="t('database.browser.empty')"
        />
        <Pagination
          v-if="idbStore.count > PAGE_SIZES[0]"
          :page="page"
          :page-size="pageSize"
          :page-sizes="PAGE_SIZES"
          :item-count="idbStore.count"
          size="small"
          class="pager"
          @update:page="setPage"
          @update:page-size="setPageSize"
        />
      </template>
      <Empty v-else :description="t('database.browser.storeGone')" />
    </section>

    <Modal
      :show="!!editingWeb"
      :title="editingWeb?.original === undefined ? t('database.browser.addItem') : t('database.browser.editItem')"
      class="json-modal"
      @update:show="(value: boolean) => !value && (editingWeb = undefined)"
    >
      <template v-if="editingWeb">
        <Input v-model:value="editingWeb.key" :placeholder="t('database.browser.key')" class="mono field" />
        <Input v-model:value="editingWeb.text" type="textarea" class="mono field" :placeholder="t('database.browser.value')" :autosize="{ minRows: 8, maxRows: 24 }" />
        <div class="json-toggle">
          <Toggle v-model:value="editingWeb.json" size="small" />
          <span class="muted small">{{ t('database.browser.saveAsJson') }}</span>
        </div>
        <Alert v-if="editingWeb.original !== undefined" type="info" class="field">{{ t('database.browser.webHint') }}</Alert>
      </template>
      <template #footer>
        <Button @click="editingWeb = undefined">{{ t('common.cancel') }}</Button>
        <Button type="warning" :disabled="!editingWeb?.key" @click="saveWeb">{{ t('common.save') }}</Button>
      </template>
    </Modal>

    <Modal
      :show="!!editingIdb"
      :title="editingIdb?.original === undefined ? t('database.browser.addRecord') : t('database.browser.editRecord')"
      class="json-modal"
      @update:show="(value: boolean) => !value && (editingIdb = undefined)"
    >
      <template v-if="editingIdb && idbStore">
        <template v-if="idbStore.keyPath === null">
          <Input v-model:value="editingIdb.keyText" :placeholder="t('database.browser.keyJson')" class="mono field" />
        </template>
        <p v-else class="muted small">{{ t('database.browser.inlineKeyHint', { path: keyPathText(idbStore.keyPath) }) }}</p>
        <Input v-model:value="editingIdb.text" type="textarea" class="mono field" :autosize="{ minRows: 8, maxRows: 24 }" />
        <p class="muted small">{{ t('database.browser.idbHint') }}</p>
      </template>
      <template #footer>
        <Button @click="editingIdb = undefined">{{ t('common.cancel') }}</Button>
        <Button type="warning" :loading="saving" @click="saveIdb">{{ t('common.save') }}</Button>
      </template>
    </Modal>

    <Modal :show="!!viewingIdb" :title="t('database.browser.view')" class="json-modal" @update:show="(value: boolean) => !value && (viewingIdb = undefined)">
      <template v-if="viewingIdb">
        <p class="muted small">{{ t('database.browser.readOnlyHint') }}</p>
        <pre class="json mono">{{ describe(viewingIdb.value) }}</pre>
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
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}

.db-name {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  word-break: break-all;
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

.table-link .mono {
  word-break: break-all;
}

.table-link.active {
  background: var(--row-hover);
  font-weight: 600;
}

.count {
  font-variant-numeric: tabular-nums;
}

.empty-db {
  padding: 0 8px;
}

.small {
  font-size: 12px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.search {
  width: 240px;
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

:deep(.value-cell) {
  cursor: pointer;
}

.field {
  margin-bottom: 10px;
}

.json-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.json {
  margin: 0;
  max-height: 60vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
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
