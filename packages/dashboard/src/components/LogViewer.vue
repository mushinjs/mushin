<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useToast } from '@mushinjs/ui'
import { Button, Checkbox, Input, RadioButton, RadioGroup } from '@mushinjs/ui'
import { foldKey, foldLines } from '@mushinjs/core/log-fold'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { renderLog } from '../logHighlight'
import { type LogRef, useLogRefs } from '../logRefs'
import { prefs } from '../prefs'
import { giveToFairy, useConversation } from '../stores/fairy'
import type { LogLine } from '../types'
import { logRef, startRefDrag } from './fairy/refs'
import IconAction from './IconAction.vue'

const props = defineProps<{ lines: LogLine[]; emptyText?: string; height?: string }>()
const emit = defineEmits<{ clear: [] }>()

const { t } = useI18n()
const router = useRouter()
const message = useToast()
const refs = useLogRefs()

const level = ref<'all' | 'info' | 'warn' | 'error'>('all')
const query = ref('')
const follow = ref(true)
const box = ref<HTMLElement>()
/** Selected source tags; none selected shows every source. */
const tags = ref<string[]>([])

const tagOrder = ['message', 'plugin', 'bot', 'adapter', 'flow', 'provider', 'fairy', 'system', 'other']
const tagOf = (line: LogLine) => line.tag ?? 'other'
// Only sources that have lines get a chip, so a bot's log shows its own few.
const presentTags = computed(() => {
  const seen = new Set(props.lines.map(tagOf))
  for (const tag of tags.value) seen.add(tag)
  return tagOrder.filter((tag) => seen.has(tag))
})

function toggleTag(tag: string) {
  tags.value = tags.value.includes(tag) ? tags.value.filter((item) => item !== tag) : [...tags.value, tag]
}

const rank: Record<string, number> = { error: 3, warn: 2, info: 1, debug: 0 }
const minimum = { all: 0, info: 1, warn: 2, error: 3 }
const hasDebug = computed(() => props.lines.some((line) => line.type === 'debug'))

const visible = computed(() => {
  const min = minimum[level.value]
  const needle = query.value.toLowerCase()
  const only = new Set(tags.value)
  return props.lines.filter((line) => (rank[line.type] ?? 1) >= min
    && (!only.size || only.has(tagOf(line)))
    && (!needle || `${line.name} ${line.text}`.toLowerCase().includes(needle)))
})

// Sequence numbers restart with the process, so a bot's log read from disk can repeat them;
// every line object gets its own key instead.
const keys = new WeakMap<LogLine, number>()
let nextKey = 0
function keyOf(line: LogLine) {
  let key = keys.get(line)
  if (key === undefined) keys.set(line, key = nextKey++)
  return key
}

// ---- folding repeats ----
// Display only: after the filters, adjacent repeats of one line or of a block of up to five lines become
// one row (or one block of rows) with a count. The lines themselves stay as they are.

/** Lines that fold together: the whole run, `period` lines repeating `count` times. */
interface Group {
  /** The key of its first line, which stays put as the group grows. */
  key: number
  lines: LogLine[]
  period: number
  count: number
}

interface Row {
  /** In a collapsed group, the key of the first occurrence's line in this place, so it stays put too. */
  key: number
  /** The line shown: in a collapsed group, the latest occurrence. */
  line: LogLine
  group?: Group
  /** In a collapsed group, the first occurrence of this row's line. */
  first?: LogLine
  /** Bracket part, for a group shown as more than one row. */
  bracket?: 'top' | 'middle' | 'bottom'
  /** The count badge goes on a group's last row. */
  badge?: boolean
}

const foldKeys = new WeakMap<LogLine, string>()
function cachedFoldKey(line: LogLine) {
  let key = foldKeys.get(line)
  if (key === undefined) foldKeys.set(line, key = foldKey(line))
  return key
}

/** Groups opened in place, by group key. */
const expanded = ref(new Set<number>())

const display = computed<Row[]>(() => {
  const list = visible.value
  if (!prefs.logFold) return list.map((line) => ({ key: keyOf(line), line }))
  const rows: Row[] = []
  for (const fold of foldLines(list, { key: cachedFoldKey })) {
    const lines = list.slice(fold.start, fold.start + fold.period * fold.count)
    if (fold.count === 1) {
      for (const line of lines) rows.push({ key: keyOf(line), line })
      continue
    }
    const group: Group = { key: keyOf(lines[0]), lines, period: fold.period, count: fold.count }
    const open = expanded.value.has(group.key)
    const shown = open ? lines : lines.slice(-fold.period)
    shown.forEach((line, index) => {
      const last = index === shown.length - 1
      rows.push({
        key: open ? keyOf(line) : keyOf(lines[index]),
        line,
        group,
        first: open ? undefined : lines[index],
        bracket: shown.length < 2 ? undefined : index === 0 ? 'top' : last ? 'bottom' : 'middle',
        badge: last,
      })
    })
  }
  return rows
})

/** Lines that folding hides right now. */
const foldedAway = computed(() => visible.value.length - display.value.length)

function toggleGroup(group: Group) {
  const next = new Set(expanded.value)
  if (!next.delete(group.key)) next.add(group.key)
  expanded.value = next
}

const DIGITS = /\d/
const MAX_VARIANTS = 8

/** The badge's tooltip: count, first and latest time, and the texts when their numbers differed. */
function groupTitle(group: Group) {
  const parts = [
    group.period > 1 ? t('logs.foldBlock', { lines: group.period, count: number(group.count) }) : t('logs.foldLine', { count: number(group.count) }),
    t('logs.foldFirst', { time: fullTime(group.lines[0].ts) }),
    t('logs.foldLatest', { time: fullTime(group.lines.at(-1)!.ts) }),
  ]
  const texts = [...new Set(group.lines.map((line) => line.text))]
  if (texts.length > group.period && texts.some((text) => DIGITS.test(text))) {
    parts.push('', t('logs.foldVariants', { count: number(texts.length) }))
    for (const text of texts.slice(-MAX_VARIANTS)) parts.push(`  ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`)
    if (texts.length > MAX_VARIANTS) parts.push(`  ${t('logs.foldMore', { count: number(texts.length - MAX_VARIANTS) })}`)
  }
  parts.push('', t(expanded.value.has(group.key) ? 'logs.foldCollapse' : 'logs.foldExpand'))
  return parts.join('\n')
}

const number = (value: number) => value.toLocaleString()
const countText = computed(() => {
  const shown = number(display.value.length)
  const total = number(props.lines.length)
  if (!foldedAway.value) return t('logs.count', { shown, total })
  const folded = number(foldedAway.value)
  return visible.value.length === props.lines.length ? t('logs.countFoldedAll', { shown, folded }) : t('logs.countFolded', { shown, total, folded })
})

// ---- rendering ----

const levelLabel: Record<string, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }
const levelOf = (line: LogLine) => levelLabel[line.type] ?? line.type.slice(0, 3).toUpperCase()

function refTitle(ref: LogRef) {
  return `${t(`logs.refs.${ref.kind}`)}: ${ref.name}`
}

// Highlighting is the costly part of a row; each line is rendered once until the known ids change.
let rendered = new WeakMap<LogLine, string>()
const renderedFor = ref(0)
watch(refs, () => {
  rendered = new WeakMap()
  renderedFor.value++
})
function html(line: LogLine) {
  void renderedFor.value
  let value = rendered.get(line)
  if (value === undefined) rendered.set(line, value = renderLog(line.text, refs.value, line.tag, refTitle))
  return value
}

const pad = (value: number, size = 2) => String(value).padStart(size, '0')
function clock(ts: number) {
  const date = new Date(ts)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
const millis = (ts: number) => `.${pad(new Date(ts).getMilliseconds(), 3)}`
const fullTime = (ts: number) => new Date(ts).toLocaleString([], { hourCycle: 'h23' })

// ---- virtual list ----

const virtualizer = useVirtualizer(computed(() => ({
  count: display.value.length,
  getScrollElement: () => box.value ?? null,
  estimateSize: () => 23,
  overscan: 16,
  getItemKey: (index: number) => display.value[index].key,
})))
const rows = computed(() => virtualizer.value.getVirtualItems().map((item) => ({ item, row: display.value[item.index] })))
const totalSize = computed(() => virtualizer.value.getTotalSize())

function measure(el: unknown) {
  if (el instanceof HTMLElement) virtualizer.value.measureElement(el)
}

// ---- following the newest line ----

let programmatic = 0
let lastTop = 0

function atBottom() {
  const el = box.value
  return !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 4
}

async function toBottom() {
  await nextTick()
  const count = display.value.length
  if (!count || !box.value) return
  programmatic++
  virtualizer.value.scrollToIndex(count - 1, { align: 'end' })
  // Rows measured on the way down can grow the list; land on the real end.
  requestAnimationFrame(() => {
    if (box.value) box.value.scrollTop = box.value.scrollHeight
    requestAnimationFrame(() => programmatic--)
  })
}

function onScroll() {
  const el = box.value
  if (!el) return
  const up = el.scrollTop < lastTop - 2
  lastTop = el.scrollTop
  if (programmatic) return
  // Scrolling up pauses following; reaching the end again resumes it.
  if (up && !atBottom()) follow.value = false
  else if (atBottom()) follow.value = true
}

function resume() {
  follow.value = true
  toBottom()
}

onMounted(toBottom)
// The last line, not the count: once the buffer is full, old lines leave as new ones arrive,
// and the last row of a folded group shows each new repeat.
watch(() => display.value.at(-1)?.line, () => {
  if (follow.value) toBottom()
})

// ---- row selection ----

const selected = ref(new Set<number>())
/** The row a Shift-click or drag measures from. */
let anchor: number | undefined

// Lines trimmed from the top or cleared simply drop out here.
const selectedRows = computed(() => selected.value.size ? display.value.filter((row) => selected.value.has(row.key)) : [])
watch(() => props.lines, () => (selected.value = new Set()))

function indexOfKey(key: number | undefined) {
  return key === undefined ? -1 : display.value.findIndex((row) => row.key === key)
}

function rangeKeys(from: number, to: number) {
  const [start, end] = from <= to ? [from, to] : [to, from]
  return display.value.slice(start, end + 1).map((row) => row.key)
}

let dragBase: Set<number> | undefined
let dragFrom = -1
let autoScroll = 0
let pointerY = 0

/** Text, links and buttons keep their own mouse behavior; everything else in a row selects it. */
function isText(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('.msg, a, button, input')
}

function rowIndex(target: Element | null) {
  const row = target?.closest<HTMLElement>('.row')
  return row && box.value?.contains(row) ? Number(row.dataset.index) : -1
}

/** A plain press on a selected row: it may start dragging the selection; a click without dragging selects just that row. */
let pressed: number | undefined

function onMouseDown(event: MouseEvent) {
  const el = box.value
  if (event.button !== 0 || !el || isText(event.target)) return
  // The scrollbar keeps working.
  if (event.target === el && (event.offsetX >= el.clientWidth || event.offsetY >= el.clientHeight)) return
  const index = rowIndex(event.target as Element)
  const plain = !event.shiftKey && !event.ctrlKey && !event.metaKey
  // Rows can be folded, so the row under the pointer is found among the displayed ones.
  if (plain && index >= 0 && selected.value.has(display.value[index]!.key)) {
    // Left to the browser, so the selected lines can be dragged into Fairy's input.
    pressed = display.value[index]!.key
    window.addEventListener('mouseup', () => {
      if (pressed !== undefined) selected.value = new Set([pressed])
      anchor = pressed ?? anchor
      pressed = undefined
    }, { once: true })
    return
  }
  // Starting here would otherwise begin a text selection across rows.
  event.preventDefault()
  window.getSelection()?.removeAllRanges()
  el.focus({ preventScroll: true })
  const toggle = event.ctrlKey || event.metaKey
  if (index < 0) {
    if (!toggle && !event.shiftKey) selected.value = new Set()
    return
  }
  const key = display.value[index].key
  if (event.shiftKey && indexOfKey(anchor) >= 0) {
    dragFrom = indexOfKey(anchor)
    dragBase = toggle ? new Set(selected.value) : new Set()
  } else if (toggle && selected.value.has(key)) {
    const next = new Set(selected.value)
    next.delete(key)
    selected.value = next
    anchor = key
    return
  } else {
    dragFrom = index
    anchor = key
    dragBase = toggle ? new Set(selected.value) : new Set()
  }
  extendTo(index)
  pointerY = event.clientY
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd, { once: true })
}

function extendTo(index: number) {
  if (!dragBase || index < 0) return
  const next = new Set(dragBase)
  for (const key of rangeKeys(dragFrom, index)) next.add(key)
  selected.value = next
}

function onDragMove(event: MouseEvent) {
  pointerY = event.clientY
  extendTo(rowIndex(document.elementFromPoint(event.clientX, event.clientY)))
  // Dragging past the top or bottom edge scrolls the list and keeps selecting.
  const rect = box.value?.getBoundingClientRect()
  const outside = rect && (pointerY < rect.top + 8 || pointerY > rect.bottom - 8)
  if (outside && !autoScroll) autoScroll = window.setInterval(stepAutoScroll, 30)
  else if (!outside) stopAutoScroll()
}

function stepAutoScroll() {
  const el = box.value
  if (!el || !dragBase) return stopAutoScroll()
  const rect = el.getBoundingClientRect()
  const up = pointerY < rect.top + 8
  const delta = up ? Math.max(-40, pointerY - rect.top - 8) : Math.min(40, pointerY - rect.bottom + 8)
  el.scrollTop += delta
  extendTo(rowIndex(document.elementFromPoint(rect.left + rect.width / 2, up ? rect.top + 10 : rect.bottom - 10)))
}

function stopAutoScroll() {
  if (autoScroll) window.clearInterval(autoScroll)
  autoScroll = 0
}

function onDragEnd() {
  window.removeEventListener('mousemove', onDragMove)
  stopAutoScroll()
  dragBase = undefined
}

onBeforeUnmount(onDragEnd)

function plainLine(line: LogLine) {
  const date = new Date(line.ts)
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day} ${clock(line.ts)}${millis(line.ts)} ${levelOf(line)} [${line.name}] ${line.text}`
}

/** A folded row copies as its latest line, with the count and the first and latest time. */
function plainRow(row: Row) {
  const text = plainLine(row.line)
  return row.first && row.group ? `${text}  (×${row.group.count}, ${clock(row.first.ts)}–${clock(row.line.ts)})` : text
}

const copyText = () => selectedRows.value.map(plainRow).join('\n')

// ---- giving lines to Fairy ----

const conversation = useConversation()

/** The selected lines as an attachment for Fairy, named by where they come from when that is one place. */
function selectionRef() {
  // Folded rows go as one line each, with their count, as they are copied.
  const rows = selectedRows.value
  if (!rows.length) return undefined
  const sources = new Set(rows.map((row) => row.line.name))
  const source = sources.size === 1 ? rows[0]!.line.name : undefined
  const label = source ? t('fairyRefs.logLabelFrom', { n: rows.length, source }, rows.length) : t('fairyRefs.logLabel', rows.length)
  return logRef(rows.map(plainRow), label, source)
}

function onRowDragStart(event: DragEvent) {
  pressed = undefined
  const item = selectionRef()
  if (item) startRefDrag(event, item)
  else event.preventDefault()
}

function giveSelection() {
  const item = selectionRef()
  if (item && !giveToFairy(item, conversation)) message.warning(t('fairyRefs.full'))
}

/** True while text is selected inside the list: then copying copies that text, as usual. */
function hasTextSelection() {
  const selection = window.getSelection()
  return !!selection && !selection.isCollapsed && !!box.value?.contains(selection.anchorNode)
}

async function copySelected() {
  const count = selectedRows.value.length
  if (!count) return
  try {
    await navigator.clipboard.writeText(copyText())
    message.success(t('logs.copied', { count }))
  } catch {
    message.error(t('logs.copyFailed'))
  }
}

function onKeyDown(event: KeyboardEvent) {
  const mod = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()
  if (mod && key === 'a') {
    event.preventDefault()
    selected.value = new Set(display.value.map((row) => row.key))
  } else if (key === 'escape' && selected.value.size) {
    selected.value = new Set()
  } else if (mod && key === 'c' && selectedRows.value.length && !hasTextSelection() && navigator.clipboard) {
    event.preventDefault()
    copySelected()
  }
}

// Without the async clipboard (plain http on another host) Ctrl+C still lands here.
function onCopy(event: ClipboardEvent) {
  if (!selectedRows.value.length || hasTextSelection() || !event.clipboardData) return
  event.clipboardData.setData('text/plain', copyText())
  event.preventDefault()
}

// Id links open their page inside the dashboard; Ctrl or middle click still opens a new tab.
function onClick(event: MouseEvent) {
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a.log-ref') : null
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return
  event.preventDefault()
  router.push(link.dataset.to!)
}
</script>

<template>
  <div class="log-view">
    <div class="bar">
      <Input v-model:value="query" size="small" clearable :placeholder="t('logs.filter')" class="search">
        <template #prefix><span class="i-lucide-search" /></template>
      </Input>
      <RadioGroup v-model:value="level" size="small">
        <RadioButton value="all">{{ t('logs.all') }}</RadioButton>
        <RadioButton v-if="hasDebug" value="info">{{ t('logs.noDebug') }}</RadioButton>
        <RadioButton value="warn">{{ t('logs.warnings') }}</RadioButton>
        <RadioButton value="error">{{ t('logs.errors') }}</RadioButton>
      </RadioGroup>
      <Checkbox v-model:checked="prefs.logFold" size="small">{{ t('logs.fold') }}</Checkbox>
      <slot name="tools" />
      <div class="spacer" />
      <IconAction icon="i-lucide-copy" :label="t('logs.copySelected')" :disabled="!selectedRows.length" @click="copySelected" />
      <IconAction icon="i-lucide-trash-2" :label="t('logs.clear')" @click="emit('clear')" />
    </div>
    <div v-if="presentTags.length > 1" class="tags" role="group" :aria-label="t('logs.tagsLabel')">
      <span class="tags-label">{{ t('logs.tagsLabel') }}</span>
      <Button
        v-for="tag in presentTags"
        :key="tag"
        size="tiny"
        round
        :type="tags.includes(tag) ? 'primary' : 'default'"
        :secondary="tags.includes(tag)"
        :quaternary="!tags.includes(tag)"
        :pressed="tags.includes(tag)"
        @click="toggleTag(tag)"
      >
        <span class="tag-dot" :class="`src-${tag}`" />{{ t(`logs.tags.${tag}`) }}
      </Button>
      <Button v-if="tags.length" size="tiny" quaternary @click="tags = []">{{ t('logs.all') }}</Button>
    </div>
    <div class="body">
      <div
        ref="box"
        class="scroller mono"
        role="log"
        aria-live="polite"
        tabindex="0"
        :style="{ height: height ?? 'min(70vh, 760px)' }"
        @scroll.passive="onScroll"
        @mousedown="onMouseDown"
        @keydown="onKeyDown"
        @copy="onCopy"
        @click="onClick"
      >
        <div v-if="display.length" class="rows" :style="{ height: `${totalSize}px` }">
          <div
            v-for="{ item, row } in rows"
            :key="String(item.key)"
            :ref="measure"
            :data-index="item.index"
            class="row"
            :class="[row.line.type, row.bracket && `grp grp-${row.bracket}`, { selected: selected.has(row.key) }]"
            :style="{ transform: `translateY(${item.start}px)` }"
            :draggable="selected.has(row.key)"
            @dragstart="onRowDragStart"
          >
            <span class="time" :title="fullTime(row.line.ts)">{{ clock(row.line.ts) }}<span class="ms">{{ millis(row.line.ts) }}</span></span>
            <span class="level" :class="`lv-${row.line.type}`">{{ levelOf(row.line) }}</span>
            <span class="source" :class="`src-${tagOf(row.line)}`" :title="row.line.name">{{ row.line.name }}</span>
            <span class="text"><span class="msg" v-html="html(row.line)" /></span>
            <button
              v-if="row.badge && row.group"
              type="button"
              class="fold-badge"
              :class="{ open: expanded.has(row.group.key) }"
              :title="groupTitle(row.group)"
              :aria-expanded="expanded.has(row.group.key)"
              @click="toggleGroup(row.group)"
            >
              ×{{ number(row.group.count) }}
            </button>
          </div>
        </div>
        <div v-else class="empty">{{ emptyText ?? t('logs.empty') }}</div>
      </div>
      <Transition name="fade">
        <Button v-if="!follow && display.length" class="latest" size="small" round secondary type="primary" icon="i-lucide-arrow-down" @click="resume">
          {{ t('logs.latest') }}
        </Button>
      </Transition>
    </div>
    <div class="status">
      <span>{{ countText }}</span>
      <template v-if="selectedRows.length">
        <span class="sep">·</span>
        <span>{{ t('logs.selected', { count: selectedRows.length }) }}</span>
        <Button text size="tiny" type="primary" @click="copySelected">{{ t('logs.copy') }}</Button>
        <Button text size="tiny" type="primary" icon="i-lucide-sparkles" :title="t('fairyRefs.giveHint')" @click="giveSelection">{{ t('fairyRefs.give') }}</Button>
        <Button text size="tiny" @click="selected = new Set()">{{ t('logs.deselect') }}</Button>
      </template>
      <span class="spacer" />
      <span class="hint">{{ t('logs.selectHint') }}</span>
    </div>
  </div>
</template>

<style scoped>
.log-view {
  border: 1px solid var(--log-border);
  border-radius: 10px;
  background: var(--log-bg);
  overflow: hidden;
}

.bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--log-border);
}

.search {
  width: 220px;
}

.spacer {
  flex: 1;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--log-border);
}

.tags-label {
  font-size: 12px;
  opacity: 0.6;
  margin-right: 2px;
}

.tag-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 6px;
  background: currentColor;
  vertical-align: 1px;
}

.body {
  position: relative;
}

.scroller {
  overflow: auto;
  scrollbar-gutter: stable;
  outline: none;
  font-size: 12px;
  line-height: 1.6;
  padding: 6px 0;
  box-sizing: border-box;
}

.rows {
  position: relative;
  width: 100%;
}

.row {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 2px 12px 2px 10px;
  border-left: 2px solid transparent;
  cursor: default;
}

.row:hover {
  background: var(--log-hover);
}

.row.warn {
  background: var(--log-warn-row);
}

.row.error {
  background: var(--log-error-row);
}

.row.warn:hover,
.row.error:hover {
  background-image: linear-gradient(var(--log-hover), var(--log-hover));
}

.row.selected,
.row.selected:hover {
  background: var(--log-selected);
  border-left-color: var(--log-accent);
}

/* Selected lines can be dragged into Fairy's input. */
.row.selected {
  cursor: grab;
}

.time,
.level,
.source {
  flex: none;
  user-select: none;
}

.time {
  color: var(--log-dim);
  font-variant-numeric: tabular-nums;
}

.ms {
  opacity: 0.6;
}

.level {
  width: 30px;
  text-align: center;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  line-height: 16px;
  margin-top: 1px;
  border-radius: 4px;
}

.lv-debug {
  color: var(--log-dim);
  background: var(--log-chip);
}

.lv-info {
  color: var(--log-info);
  background: var(--log-info-bg);
}

.lv-warn {
  color: var(--log-warn);
  background: var(--log-warn-bg);
}

.lv-error {
  color: var(--log-error);
  background: var(--log-error-bg);
}

.source {
  width: 84px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg {
  cursor: text;
}

/* A block of lines that repeats: a thin bracket on its left, across its rows. */
.row.grp::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 0;
  bottom: 0;
  width: 4px;
  border-left: 1.5px solid var(--log-dim);
  opacity: 0.55;
  pointer-events: none;
}

.row.grp-top::before {
  top: 7px;
  border-top: 1.5px solid var(--log-dim);
  border-top-left-radius: 3px;
}

.row.grp-bottom::before {
  bottom: 7px;
  border-bottom: 1.5px solid var(--log-dim);
  border-bottom-left-radius: 3px;
}

.fold-badge {
  flex: none;
  margin-top: 1px;
  padding: 0 6px;
  border: none;
  border-radius: 8px;
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--log-dim);
  background: var(--log-chip);
  cursor: pointer;
  user-select: none;
}

.fold-badge:hover,
.fold-badge.open {
  color: var(--log-accent);
  background: var(--log-selected);
}

.fold-badge:focus-visible {
  outline: 2px solid var(--log-accent);
  outline-offset: 1px;
}

.row.debug .msg {
  opacity: 0.7;
}

.empty {
  opacity: 0.5;
  padding: 48px 16px;
  text-align: center;
  font-family: system-ui, sans-serif;
}

.latest {
  position: absolute;
  right: 20px;
  bottom: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.status {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  padding: 6px 12px;
  border-top: 1px solid var(--log-border);
  font-size: 12px;
  color: var(--log-dim);
}

.sep {
  opacity: 0.6;
}

.hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 640px) {
  .search {
    width: 100%;
  }

  .hint {
    display: none;
  }

  .source {
    width: 56px;
  }
}
</style>

<style>
/* Log colors per theme: line chrome, highlight.js scopes from logHighlight.ts and ansi_up classes. */
.log-view {
  --log-bg: #fcfcfd;
  --log-border: rgba(0, 0, 0, 0.08);
  --log-hover: rgba(127, 127, 127, 0.08);
  --log-selected: rgba(59, 74, 140, 0.12);
  --log-accent: var(--primary);
  --log-dim: #8a8f98;
  --log-chip: rgba(127, 127, 127, 0.12);
  --log-info: #2f6fbf;
  --log-info-bg: rgba(47, 111, 191, 0.1);
  --log-warn: #b26a00;
  --log-warn-bg: rgba(240, 160, 32, 0.16);
  --log-warn-row: rgba(240, 160, 32, 0.05);
  --log-error: #c42b4b;
  --log-error-bg: rgba(208, 48, 80, 0.12);
  --log-error-row: rgba(208, 48, 80, 0.05);
  --log-ref: var(--primary);
  --log-string: #3f8f3a;
  --log-number: #a35f00;
  --log-date: #0e7d98;
  --log-link: #2a63d4;
  --log-path: #9a3fa8;
  --log-attr: #c24e3c;
  --log-literal: #0e7d98;
  --log-good: #2d8a4e;
  --log-src-message: #4f5bd5;
  --log-src-plugin: #8a4fc4;
  --log-src-bot: #2f6fbf;
  --log-src-adapter: #0e8a8a;
  --log-src-flow: #2d8a4e;
  --log-src-provider: #c46a12;
  --log-src-fairy: #c2417a;
  --log-src-system: #6b7280;
  --log-src-other: #8a8f98;
}

html[data-theme='dark'] .log-view {
  --log-bg: #141417;
  --log-border: rgba(255, 255, 255, 0.09);
  --log-hover: rgba(255, 255, 255, 0.05);
  --log-selected: rgba(141, 155, 230, 0.18);
  --log-accent: #8d9be6;
  --log-dim: #7d828c;
  --log-chip: rgba(255, 255, 255, 0.08);
  --log-info: #6aa8f0;
  --log-info-bg: rgba(106, 168, 240, 0.14);
  --log-warn: #e8b04b;
  --log-warn-bg: rgba(232, 176, 75, 0.16);
  --log-warn-row: rgba(232, 176, 75, 0.05);
  --log-error: #f07085;
  --log-error-bg: rgba(240, 112, 133, 0.15);
  --log-error-row: rgba(240, 112, 133, 0.06);
  --log-ref: #a3afee;
  --log-string: #98c379;
  --log-number: #d19a66;
  --log-date: #56b6c2;
  --log-link: #61afef;
  --log-path: #c678dd;
  --log-attr: #e88388;
  --log-literal: #56b6c2;
  --log-good: #7ccf8f;
  --log-src-message: #8e97f0;
  --log-src-plugin: #b78ce8;
  --log-src-bot: #6aa8f0;
  --log-src-adapter: #4fc4c4;
  --log-src-flow: #7ccf8f;
  --log-src-provider: #e89a52;
  --log-src-fairy: #ec7fb0;
  --log-src-system: #9aa0aa;
  --log-src-other: #7d828c;
}

.log-view .src-message { color: var(--log-src-message); }
.log-view .src-plugin { color: var(--log-src-plugin); }
.log-view .src-bot { color: var(--log-src-bot); }
.log-view .src-adapter { color: var(--log-src-adapter); }
.log-view .src-flow { color: var(--log-src-flow); }
.log-view .src-provider { color: var(--log-src-provider); }
.log-view .src-fairy { color: var(--log-src-fairy); }
.log-view .src-system { color: var(--log-src-system); }
.log-view .src-other { color: var(--log-src-other); }

.log-view .hljs-string { color: var(--log-string); }
.log-view .hljs-number { color: var(--log-number); }
.log-view .hljs-date,
.log-view .hljs-address { color: var(--log-date); }
.log-view .hljs-link { color: var(--log-link); }
.log-view .hljs-path { color: var(--log-path); }
.log-view .hljs-attr { color: var(--log-attr); }
.log-view .hljs-literal { color: var(--log-literal); }
.log-view .hljs-bad { color: var(--log-error); font-weight: 600; }
.log-view .hljs-caution { color: var(--log-warn); }
.log-view .hljs-good { color: var(--log-good); }
.log-view .hljs-frame { color: var(--log-dim); }

/* The message of an error or warning takes the level's color; its highlighted words keep theirs. */
.log-view .row.error .msg { color: var(--log-error); }
.log-view .row.warn .msg { color: var(--log-warn); }

.log-view a.log-ref {
  color: var(--log-ref);
  text-decoration: underline dotted;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  cursor: pointer;
}

.log-view a.log-ref:hover {
  text-decoration-style: solid;
}

.log-view .ansi-black-fg, .log-view .ansi-bright-black-fg { color: var(--log-dim); }
.log-view .ansi-red-fg, .log-view .ansi-bright-red-fg { color: var(--log-error); }
.log-view .ansi-green-fg, .log-view .ansi-bright-green-fg { color: var(--log-string); }
.log-view .ansi-yellow-fg, .log-view .ansi-bright-yellow-fg { color: var(--log-warn); }
.log-view .ansi-blue-fg, .log-view .ansi-bright-blue-fg { color: var(--log-link); }
.log-view .ansi-magenta-fg, .log-view .ansi-bright-magenta-fg { color: var(--log-path); }
.log-view .ansi-cyan-fg, .log-view .ansi-bright-cyan-fg { color: var(--log-date); }
.log-view .ansi-white-fg, .log-view .ansi-bright-white-fg { color: inherit; }
.log-view .ansi-red-bg, .log-view .ansi-bright-red-bg { background: var(--log-error-bg); }
.log-view .ansi-yellow-bg, .log-view .ansi-bright-yellow-bg { background: var(--log-warn-bg); }
.log-view .ansi-blue-bg, .log-view .ansi-bright-blue-bg,
.log-view .ansi-cyan-bg, .log-view .ansi-bright-cyan-bg { background: var(--log-info-bg); }
.log-view .ansi-green-bg, .log-view .ansi-bright-green-bg,
.log-view .ansi-magenta-bg, .log-view .ansi-bright-magenta-bg,
.log-view .ansi-black-bg, .log-view .ansi-bright-black-bg,
.log-view .ansi-white-bg, .log-view .ansi-bright-white-bg { background: var(--log-chip); }
</style>
