<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useToast } from '@mushin/ui'
import { Button, Input, RadioButton, RadioGroup } from '@mushin/ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { renderLog } from '../logHighlight'
import { type LogRef, useLogRefs } from '../logRefs'
import type { LogLine } from '../types'
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

const tagOrder = ['plugin', 'bot', 'adapter', 'flow', 'provider', 'agent', 'system', 'other']
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
const fullTime = (ts: number) => new Date(ts).toLocaleString()

// ---- virtual list ----

const virtualizer = useVirtualizer(computed(() => ({
  count: visible.value.length,
  getScrollElement: () => box.value ?? null,
  estimateSize: () => 23,
  overscan: 16,
  getItemKey: (index: number) => keyOf(visible.value[index]),
})))
const rows = computed(() => virtualizer.value.getVirtualItems().map((item) => ({ item, line: visible.value[item.index] })))
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
  const count = visible.value.length
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
// The last line, not the count: once the buffer is full, old lines leave as new ones arrive.
watch(() => visible.value.at(-1), () => {
  if (follow.value) toBottom()
})

// ---- row selection ----

const selected = ref(new Set<number>())
/** The row a Shift-click or drag measures from. */
let anchor: number | undefined

// Lines trimmed from the top or cleared simply drop out here.
const selectedLines = computed(() => selected.value.size ? visible.value.filter((line) => selected.value.has(keyOf(line))) : [])
watch(() => props.lines, () => (selected.value = new Set()))

function indexOfKey(key: number | undefined) {
  return key === undefined ? -1 : visible.value.findIndex((line) => keyOf(line) === key)
}

function rangeKeys(from: number, to: number) {
  const [start, end] = from <= to ? [from, to] : [to, from]
  return visible.value.slice(start, end + 1).map(keyOf)
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

function onMouseDown(event: MouseEvent) {
  const el = box.value
  if (event.button !== 0 || !el || isText(event.target)) return
  // The scrollbar keeps working.
  if (event.target === el && (event.offsetX >= el.clientWidth || event.offsetY >= el.clientHeight)) return
  const index = rowIndex(event.target as Element)
  // Starting here would otherwise begin a text selection across rows.
  event.preventDefault()
  window.getSelection()?.removeAllRanges()
  el.focus({ preventScroll: true })
  const toggle = event.ctrlKey || event.metaKey
  if (index < 0) {
    if (!toggle && !event.shiftKey) selected.value = new Set()
    return
  }
  const key = keyOf(visible.value[index])
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

const copyText = () => selectedLines.value.map(plainLine).join('\n')

/** True while text is selected inside the list: then copying copies that text, as usual. */
function hasTextSelection() {
  const selection = window.getSelection()
  return !!selection && !selection.isCollapsed && !!box.value?.contains(selection.anchorNode)
}

async function copySelected() {
  const count = selectedLines.value.length
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
    selected.value = new Set(visible.value.map(keyOf))
  } else if (key === 'escape' && selected.value.size) {
    selected.value = new Set()
  } else if (mod && key === 'c' && selectedLines.value.length && !hasTextSelection() && navigator.clipboard) {
    event.preventDefault()
    copySelected()
  }
}

// Without the async clipboard (plain http on another host) Ctrl+C still lands here.
function onCopy(event: ClipboardEvent) {
  if (!selectedLines.value.length || hasTextSelection() || !event.clipboardData) return
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
      <div class="spacer" />
      <IconAction icon="i-lucide-copy" :label="t('logs.copySelected')" :disabled="!selectedLines.length" @click="copySelected" />
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
        <div v-if="visible.length" class="rows" :style="{ height: `${totalSize}px` }">
          <div
            v-for="{ item, line } in rows"
            :key="String(item.key)"
            :ref="measure"
            :data-index="item.index"
            class="row"
            :class="[line.type, { selected: selected.has(item.key as number) }]"
            :style="{ transform: `translateY(${item.start}px)` }"
          >
            <span class="time" :title="fullTime(line.ts)">{{ clock(line.ts) }}<span class="ms">{{ millis(line.ts) }}</span></span>
            <span class="level" :class="`lv-${line.type}`">{{ levelOf(line) }}</span>
            <span class="source" :class="`src-${tagOf(line)}`" :title="line.name">{{ line.name }}</span>
            <span class="text"><span class="msg" v-html="html(line)" /></span>
          </div>
        </div>
        <div v-else class="empty">{{ emptyText ?? t('logs.empty') }}</div>
      </div>
      <Transition name="fade">
        <Button v-if="!follow && visible.length" class="latest" size="small" round secondary type="primary" icon="i-lucide-arrow-down" @click="resume">
          {{ t('logs.latest') }}
        </Button>
      </Transition>
    </div>
    <div class="status">
      <span>{{ t('logs.count', { shown: visible.length, total: lines.length }) }}</span>
      <template v-if="selectedLines.length">
        <span class="sep">·</span>
        <span>{{ t('logs.selected', { count: selectedLines.length }) }}</span>
        <Button text size="tiny" type="primary" @click="copySelected">{{ t('logs.copy') }}</Button>
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
  --log-src-plugin: #8a4fc4;
  --log-src-bot: #2f6fbf;
  --log-src-adapter: #0e8a8a;
  --log-src-flow: #2d8a4e;
  --log-src-provider: #c46a12;
  --log-src-agent: #c2417a;
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
  --log-src-plugin: #b78ce8;
  --log-src-bot: #6aa8f0;
  --log-src-adapter: #4fc4c4;
  --log-src-flow: #7ccf8f;
  --log-src-provider: #e89a52;
  --log-src-agent: #ec7fb0;
  --log-src-system: #9aa0aa;
  --log-src-other: #7d828c;
}

.log-view .src-plugin { color: var(--log-src-plugin); }
.log-view .src-bot { color: var(--log-src-bot); }
.log-view .src-adapter { color: var(--log-src-adapter); }
.log-view .src-flow { color: var(--log-src-flow); }
.log-view .src-provider { color: var(--log-src-provider); }
.log-view .src-agent { color: var(--log-src-agent); }
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
