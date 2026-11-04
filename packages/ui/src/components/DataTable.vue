<script setup lang="ts" generic="Row">
/**
 * A table drawn from column definitions, in the shape Naive UI's data table took:
 * `{ key, title, render?(row, index), width?, minWidth?, align?, ellipsis?, fixed?, sorter? }`.
 *
 * - `render` returns text or VNodes; without it the cell shows `row[key]`.
 * - `ellipsis` cuts a cell to one line; the full text shows on hover when it is plain text.
 * - `fixed: 'left' | 'right'` keeps a column in view while the table scrolls sideways.
 * - `sorter: true` makes the header clickable. Sorting is left to the page: it gets
 *   `update:sorter` with `{ columnKey, order }` and passes the order back as `sortOrder`.
 * - `scrollX` is the narrowest the table gets before it scrolls sideways. Columns then keep their
 *   `width`, and the ones without share what is left. `maxHeight` scrolls the table down with the
 *   header kept in view.
 * - `rowProps(row)` adds attributes to a row, such as a class or an onClick.
 */
import { computed, type VNodeChild } from 'vue'
import { useText } from '../config'
import Empty from './Empty.vue'

export type SortOrder = 'ascend' | 'descend' | false

export interface DataTableColumn<R = any> {
  key: string
  title?: string | (() => VNodeChild)
  render?: (row: R, index: number) => VNodeChild
  width?: number | string
  minWidth?: number | string
  align?: 'left' | 'center' | 'right'
  ellipsis?: boolean | { tooltip?: boolean }
  fixed?: 'left' | 'right'
  sorter?: boolean
  sortOrder?: SortOrder
  className?: string
}

export interface DataTableSortState {
  columnKey: string
  order: SortOrder
}

const props = withDefaults(defineProps<{
  columns: DataTableColumn<Row>[]
  data: Row[]
  rowKey?: (row: Row) => string | number
  rowProps?: (row: Row, index: number) => Record<string, unknown>
  loading?: boolean
  size?: 'small' | 'medium'
  bordered?: boolean
  scrollX?: number | string
  maxHeight?: number | string
  /** Shown when there are no rows. */
  emptyText?: string
}>(), { size: 'medium', bordered: false })

const emit = defineEmits<{ 'update:sorter': [state: DataTableSortState] }>()
const text = useText()

const px = (value: number | string | undefined) => (value === undefined ? undefined : typeof value === 'number' ? `${value}px` : value)

// Sticky columns need their offset from the edge: the widths of the fixed columns before them.
const offsets = computed(() => {
  const result = new Map<string, string>()
  const place = (list: DataTableColumn<Row>[]) => {
    const parts: string[] = []
    for (const column of list) {
      result.set(column.key, parts.length ? `calc(${parts.join(' + ')})` : '0px')
      parts.push(px(column.width ?? column.minWidth) ?? '0px')
    }
  }
  place(props.columns.filter((column) => column.fixed === 'left'))
  place(props.columns.filter((column) => column.fixed === 'right').reverse())
  return result
})

function cellStyle(column: DataTableColumn<Row>) {
  return {
    width: px(column.width),
    minWidth: px(column.minWidth ?? column.width),
    maxWidth: column.ellipsis ? px(column.width) : undefined,
    textAlign: column.align,
    ...(column.fixed ? { [column.fixed]: offsets.value.get(column.key) } : {}),
  }
}

function cellClass(column: DataTableColumn<Row>) {
  return [column.className, {
    'is-fixed': column.fixed,
    [`is-fixed-${column.fixed}`]: column.fixed,
    'is-ellipsis': column.ellipsis,
  }]
}

const value = (row: Row, column: DataTableColumn<Row>, index: number): VNodeChild => {
  if (column.render) return column.render(row, index)
  const raw = (row as Record<string, unknown>)[column.key]
  return raw === null || raw === undefined ? '' : String(raw)
}

// The full text on hover, for a cut-off cell that is plain text.
function hint(row: Row, column: DataTableColumn<Row>, index: number) {
  if (!column.ellipsis || (typeof column.ellipsis === 'object' && column.ellipsis.tooltip === false)) return undefined
  const content = value(row, column, index)
  return typeof content === 'string' || typeof content === 'number' ? String(content) : undefined
}

function sort(column: DataTableColumn<Row>) {
  if (!column.sorter) return
  const next: SortOrder = column.sortOrder === 'ascend' ? 'descend' : column.sortOrder === 'descend' ? false : 'ascend'
  emit('update:sorter', { columnKey: column.key, order: next })
}

const keyOf = (row: Row, index: number) => (props.rowKey ? props.rowKey(row) : index)

// Renders a render function's output, so cells can hold VNodes.
const Content = (p: { render: () => VNodeChild }) => p.render()
</script>

<template>
  <div class="mu-table" :class="[`mu-table--${size}`, { 'mu-table--bordered': bordered, 'is-loading': loading }]">
    <div class="mu-table__scroll" :style="{ maxHeight: px(maxHeight) }">
      <table :style="{ minWidth: px(scrollX), tableLayout: scrollX === undefined ? undefined : 'fixed' }">
        <thead>
          <tr>
            <th
              v-for="column in columns"
              :key="column.key"
              :class="[cellClass(column), { 'is-sortable': column.sorter, 'is-sorted': column.sortOrder }]"
              :style="cellStyle(column)"
              :aria-sort="column.sortOrder === 'ascend' ? 'ascending' : column.sortOrder === 'descend' ? 'descending' : undefined"
            >
              <button v-if="column.sorter" type="button" class="mu-table__sort" @click="sort(column)">
                <Content :render="() => (typeof column.title === 'function' ? column.title() : column.title)" />
                <span class="mu-table__sort-icon" :class="column.sortOrder === 'ascend' ? 'i-lucide-arrow-up' : column.sortOrder === 'descend' ? 'i-lucide-arrow-down' : 'i-lucide-arrow-up-down'" />
              </button>
              <Content v-else :render="() => (typeof column.title === 'function' ? column.title() : column.title)" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in data" :key="keyOf(row, index)" v-bind="rowProps?.(row, index)">
            <td v-for="column in columns" :key="column.key" :class="cellClass(column)" :style="cellStyle(column)" :title="hint(row, column, index)">
              <Content :render="() => value(row, column, index)" />
            </td>
          </tr>
        </tbody>
      </table>
      <Empty v-if="!data.length && !loading" size="small" :description="emptyText" class="mu-table__empty" />
    </div>
    <div v-if="loading" class="mu-table__mask"><span class="i-lucide-loader-circle mu-spin" :aria-label="text.loading" /></div>
  </div>
</template>

<style>
.mu-table {
  position: relative;
  min-width: 0;
  font-size: 13.5px;
}

.mu-table__scroll {
  overflow: auto;
  min-width: 0;
}

.mu-table table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
}

.mu-table th,
.mu-table td {
  box-sizing: border-box;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--s1);
  text-align: left;
  vertical-align: middle;
}

.mu-table--small th,
.mu-table--small td { padding: 7px 10px; }

.mu-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--s2);
  color: var(--fg2);
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
}

.mu-table td { color: var(--fg); }
.mu-table tbody tr:last-child td { border-bottom: 0; }
.mu-table tbody tr:hover td { background: var(--s2); }

.mu-table--bordered { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.mu-table--bordered th + th,
.mu-table--bordered td + td { border-left: 1px solid var(--line); }

.mu-table .is-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mu-table .is-fixed { position: sticky; z-index: 1; }
.mu-table th.is-fixed { z-index: 2; }
.mu-table .is-fixed-left { box-shadow: inset -1px 0 0 var(--line); }
.mu-table .is-fixed-right { box-shadow: inset 1px 0 0 var(--line); }

.mu-table__sort {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.mu-table__sort:hover { color: var(--fg); }
.mu-table__sort:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--focus); border-radius: 3px; }
.mu-table__sort-icon { flex: none; font-size: 12px; opacity: 0.45; }
.mu-table th.is-sorted { color: var(--primary); }
.mu-table th.is-sorted .mu-table__sort-icon { opacity: 1; }

.mu-table__empty { background: var(--s1); }

.mu-table__mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--s1) 55%, transparent);
  color: var(--primary);
  font-size: 22px;
}
</style>
