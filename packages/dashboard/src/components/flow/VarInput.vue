<script setup lang="ts">
/**
 * Text with references to earlier nodes' outputs. References show as chips that read
 * `节点名.字段` (hover for the latest value; red when they point at nothing that runs before
 * this node). Typing `{{` lists what can be referenced, as does the (x) button; picking inserts
 * `{{<node id>.<field>}}`. The value stays plain text, so the server reads it as before.
 */
import { Button } from '@mushin/ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { REF } from '../../flow'
import { type RefItem, useRefs } from './editor/useRefs'

const props = defineProps<{
  placeholder?: string
  multiline?: boolean
  /** Monospace, for JSON. */
  mono?: boolean
  status?: 'error' | 'warning'
}>()
const value = defineModel<string>({ default: '' })
const { t } = useI18n()
const { groups, look } = useRefs()

const editor = ref<HTMLDivElement>()
/** The text the editor shows now, to tell our own updates from outside ones. */
let shown = ''
let composing = false

// ---- text ↔ editor ----

function chipFor(text: string) {
  const info = look(text)
  const chip = document.createElement('span')
  chip.className = info.invalid ? 'ref-chip invalid' : 'ref-chip'
  chip.contentEditable = 'false'
  chip.dataset.ref = text
  chip.textContent = info.label
  chip.title = info.title
  return chip
}

function render(text: string) {
  const root = editor.value
  if (!root) return
  const parts: Node[] = []
  let last = 0
  for (const match of text.matchAll(REF)) {
    if (match.index > last) parts.push(document.createTextNode(text.slice(last, match.index)))
    parts.push(chipFor(match[0]))
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(document.createTextNode(text.slice(last)))
  // A last empty line only shows with something after it.
  if (text.endsWith('\n')) parts.push(document.createElement('br'))
  root.replaceChildren(...parts)
  shown = text
}

/** The text a piece of the editor stands for: chips give their reference, line breaks a newline. */
function serialize(node: Node): string {
  let out = ''
  node.childNodes.forEach((child) => {
    // Browsers may type a no-break space for a plain one at the end of a line.
    if (child.nodeType === Node.TEXT_NODE) out += (child.textContent ?? '').replace(/\u00a0/g, ' ')
    else if (child instanceof HTMLElement) {
      if (child.dataset.ref) out += child.dataset.ref
      else if (child.tagName === 'BR') out += child === node.lastChild ? '' : '\n'
      else out += (out && !out.endsWith('\n') ? '\n' : '') + serialize(child)
    }
  })
  return out
}

const clean = (text: string) => (props.multiline ? text : text.replace(/\n/g, ''))

// ---- caret, as an offset into the text ----

function offsetOf(container: Node, offset: number) {
  const root = editor.value!
  const range = document.createRange()
  range.setStart(root, 0)
  range.setEnd(container, offset)
  return serialize(range.cloneContents()).length
}

/** Where the selection starts and ends in the text, or nothing when it is not in the editor. */
function selection(): [number, number] | undefined {
  const current = window.getSelection()
  const root = editor.value
  if (!current?.rangeCount || !root) return
  const range = current.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return
  return [offsetOf(range.startContainer, range.startOffset), offsetOf(range.endContainer, range.endOffset)]
}

function placeCaret(offset: number) {
  const root = editor.value
  if (!root) return
  const range = document.createRange()
  range.setStart(root, root.childNodes.length)
  let left = offset
  for (const child of [...root.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      const length = (child.textContent ?? '').length
      if (left <= length) {
        range.setStart(child, left)
        break
      }
      left -= length
      continue
    }
    // A chip is its reference's length; a line break one, unless it only shows the last empty line.
    const length = child instanceof HTMLElement && child.dataset.ref ? child.dataset.ref.length : child === root.lastChild ? 0 : 1
    if (!length) continue
    if (left === 0) {
      range.setStartBefore(child)
      break
    }
    if (left <= length) {
      range.setStartAfter(child)
      break
    }
    left -= length
  }
  range.collapse(true)
  const current = window.getSelection()
  current?.removeAllRanges()
  current?.addRange(range)
}

/** Replaces part of the text and puts the caret after what went in. */
function replace(start: number, end: number, insert: string) {
  const text = clean(`${shown.slice(0, start)}${insert}${shown.slice(end)}`)
  render(text)
  value.value = text
  editor.value?.focus()
  placeCaret(start + insert.length)
}

// ---- typing ----

/** Where the last selection in the editor was, for the (x) button. */
let saved: [number, number] | undefined

function onInput() {
  if (composing) return
  const text = clean(serialize(editor.value!))
  const caret = selection()
  // A reference typed out in full becomes a chip; so does text that is no longer what is shown.
  const rawRef = [...editor.value!.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && new RegExp(REF.source, 'u').test(child.textContent ?? ''))
  if (rawRef || text !== serialize(editor.value!)) {
    render(text)
    if (caret) placeCaret(caret[1])
  }
  shown = text
  value.value = text
  updateMenu()
}

function onPaste(event: ClipboardEvent) {
  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') ?? ''
  const range = selection() ?? [shown.length, shown.length]
  replace(range[0], range[1], clean(text.replace(/\r\n?/g, '\n')))
}

function onKeydown(event: KeyboardEvent) {
  if (menu.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const count = flat.value.length
      if (count) active.value = (active.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
      scrollActive()
      return
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && flat.value[active.value]) {
      event.preventDefault()
      pick(flat.value[active.value])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      menu.value = undefined
      return
    }
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (!props.multiline || event.isComposing) return
    const range = selection()
    if (range) replace(range[0], range[1], '\n')
  }
}

function onCompositionEnd() {
  composing = false
  onInput()
}

function onSelectionChange() {
  const range = selection()
  if (range) saved = range
}

// ---- the reference menu ----

/** Open from typing `{{` (with the text typed since and where it starts) or from the button. */
const menu = ref<{ query: string; start: number; end: number; x: number; y: number }>()
const active = ref(0)
const list = ref<HTMLElement>()

const flat = computed(() => filtered.value.flatMap((group) => group.items))
const filtered = computed(() => {
  const query = menu.value?.query.trim().toLowerCase() ?? ''
  if (!query) return groups.value
  return groups.value
    .map((group) => ({ ...group, items: group.items.filter((item) => `${item.node} ${item.field} ${item.ref}`.toLowerCase().includes(query)) }))
    .filter((group) => group.items.length)
})
watch(() => menu.value?.query, () => (active.value = 0))

function caretBox() {
  const current = window.getSelection()
  if (!current?.rangeCount) return
  const rect = current.getRangeAt(0).getBoundingClientRect()
  // A collapsed caret at the start of a line can have no box; fall back to the editor's.
  return rect.width || rect.height ? rect : editor.value?.getBoundingClientRect()
}

/** Opens the menu when the text before the caret is `{{` and what was typed after it. */
function updateMenu() {
  const range = selection()
  if (!range || range[0] !== range[1]) {
    menu.value = undefined
    return
  }
  const before = shown.slice(0, range[1])
  const match = /\{\{\s*([^{}\s]*)$/.exec(before)
  if (!match) {
    menu.value = undefined
    return
  }
  const box = caretBox()
  menu.value = { query: match[1], start: range[1] - match[0].length, end: range[1], x: box?.left ?? 0, y: (box?.bottom ?? 0) + 4 }
}

function openFromButton(event: MouseEvent) {
  const range = saved ?? [shown.length, shown.length]
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  menu.value = { query: '', start: range[0], end: range[1], x: Math.max(8, box.right - 280), y: box.bottom + 4 }
}

function pick(item: RefItem) {
  if (!menu.value) return
  const { start, end } = menu.value
  menu.value = undefined
  replace(start, end, item.ref)
}

function scrollActive() {
  void nextTick(() => list.value?.querySelector('.active')?.scrollIntoView({ block: 'nearest' }))
}

function onDocumentDown(event: MouseEvent) {
  const target = event.target as Node
  if (menu.value && !list.value?.contains(target) && !editor.value?.contains(target)) menu.value = undefined
}

// ---- keeping up ----

watch(value, (next) => {
  if ((next ?? '') !== shown) render(next ?? '')
})
// Chips follow renamed nodes, new runs and changed wiring.
const looks = computed(() => [...(value.value ?? '').matchAll(REF)].map((match) => JSON.stringify(look(match[0]))).join())
watch(looks, () => {
  const caret = document.activeElement === editor.value ? selection() : undefined
  render(shown)
  if (caret) placeCaret(caret[1])
})

onMounted(() => {
  render(value.value ?? '')
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('mousedown', onDocumentDown, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', onSelectionChange)
  document.removeEventListener('mousedown', onDocumentDown, true)
})
</script>

<template>
  <div class="var-input" :class="{ multiline, mono, [`is-${status}`]: !!status }">
    <div
      ref="editor"
      class="field"
      :class="{ empty: !value }"
      contenteditable="true"
      role="textbox"
      :aria-multiline="multiline ? 'true' : 'false'"
      :data-placeholder="placeholder ?? t('flows.varsPlaceholder')"
      spellcheck="false"
      @input="onInput"
      @keydown="onKeydown"
      @keyup="(event) => !['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key) && updateMenu()"
      @click="updateMenu"
      @paste="onPaste"
      @compositionstart="composing = true"
      @compositionend="onCompositionEnd"
    />
    <Button text size="tiny" class="var-button" :title="t('flows.varsInsert')" :aria-label="t('flows.varsInsert')" @mousedown.prevent @click="openFromButton">(x)</Button>
    <Teleport to="body">
      <div v-if="menu" ref="list" class="ref-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" role="listbox" @mousedown.prevent>
        <template v-for="group in filtered" :key="group.key">
          <div class="ref-group">{{ group.label }}</div>
          <div
            v-for="item in group.items"
            :key="item.ref"
            class="ref-item"
            :class="{ active: flat[active] === item }"
            role="option"
            :aria-selected="flat[active] === item"
            @mouseenter="active = flat.indexOf(item)"
            @click="pick(item)"
          >
            <span class="ref-name">{{ item.node }} <span class="ref-sep">›</span> {{ item.field }}</span>
            <span class="ref-type">{{ item.type }}</span>
            <span v-if="item.sample !== undefined" class="ref-sample" :title="item.sample">{{ item.sample || '""' }}</span>
          </div>
        </template>
        <div v-if="!flat.length" class="ref-none">{{ t('flows.refNone') }}</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.var-input {
  position: relative;
  display: flex;
  align-items: flex-start;
  width: 100%;
  min-height: 28px;
  box-sizing: border-box;
  padding: 0 4px 0 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--s2);
  color: var(--fg);
  font-size: 13px;
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s;
}

.var-input:hover {
  border-color: var(--line-strong);
}

.var-input:focus-within {
  border-color: var(--primary);
  background: var(--s1);
  box-shadow: 0 0 0 3px var(--focus);
}

.var-input.is-error {
  border-color: var(--bad);
}

.var-input.is-warning {
  border-color: var(--warn);
}

.field {
  flex: 1;
  min-width: 0;
  padding: 4px 0;
  line-height: 18px;
  outline: none;
  white-space: pre;
  overflow-x: auto;
  scrollbar-width: none;
}

.multiline .field {
  min-height: 46px;
  max-height: 220px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.55;
}

.mono .field {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
}

.field.empty::before {
  content: attr(data-placeholder);
  color: var(--fg3);
  pointer-events: none;
}

.field :deep(.ref-chip) {
  display: inline-block;
  max-width: 100%;
  margin: 0 1px;
  padding: 0 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--primary) 16%, transparent);
  color: var(--primary);
  font-family: var(--font, inherit);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  cursor: default;
  user-select: all;
}

.field :deep(.ref-chip.invalid) {
  background: color-mix(in srgb, var(--bad) 16%, transparent);
  color: var(--bad);
  text-decoration: line-through dotted;
}

.var-button {
  flex: none;
  margin-top: 2px;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  color: var(--primary);
}

.ref-menu {
  position: fixed;
  z-index: 3000;
  width: 280px;
  max-height: 300px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--s1);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
  font-size: 13px;
}

.ref-group {
  padding: 6px 8px 2px;
  color: var(--fg3);
  font-size: 11px;
}

.ref-item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0 8px;
  padding: 4px 8px;
  border-radius: 5px;
  cursor: pointer;
}

.ref-item.active {
  background: var(--s2);
}

.ref-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ref-sep {
  color: var(--fg3);
}

.ref-type {
  color: var(--fg3);
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 11px;
}

.ref-sample {
  grid-column: 1 / -1;
  overflow: hidden;
  color: var(--fg3);
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ref-none {
  padding: 8px;
  color: var(--fg3);
}
</style>
