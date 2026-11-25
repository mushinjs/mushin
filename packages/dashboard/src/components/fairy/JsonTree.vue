<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * A value as a tree that opens a level at a time: objects and arrays show their size until opened, plain
 * values show inline. The top level starts open.
 */
const props = withDefaults(defineProps<{ value: unknown; label?: string | number; depth?: number; open?: boolean }>(), { depth: 0 })

const { t } = useI18n()

/** Children shown at once; the rest wait behind a button, so a long list does not flood the chat. */
const SHOWN = 50

const branch = computed(() => props.value !== null && typeof props.value === 'object')
const entries = computed(() => (branch.value ? Object.entries(props.value as object) : []))
const isOpen = ref(props.open ?? props.depth < 1)
const all = ref(false)
const shown = computed(() => (all.value ? entries.value : entries.value.slice(0, SHOWN)))

const size = computed(() => (Array.isArray(props.value) ? `[${entries.value.length}]` : `{${entries.value.length}}`))

/** A preview of a closed branch: its first keys or values. */
const peek = computed(() => {
  if (!branch.value || isOpen.value) return ''
  const items = entries.value.slice(0, 3).map(([key, value]) => (Array.isArray(props.value) ? leafText(value, 16) : key))
  return items.join(', ') + (entries.value.length > 3 ? ', …' : '')
})

function leafText(value: unknown, max = 400) {
  if (value !== null && typeof value === 'object') return Array.isArray(value) ? `[${value.length}]` : '{…}'
  const text = typeof value === 'string' ? JSON.stringify(value) : String(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const leafClass = computed(() => (props.value === null ? 'null' : typeof props.value))
</script>

<template>
  <div class="jt" :class="{ root: depth === 0 }">
    <template v-if="branch">
      <button type="button" class="jt-row jt-toggle" :aria-expanded="isOpen" @click="isOpen = !isOpen">
        <span class="i-lucide-chevron-right jt-caret" :class="{ open: isOpen }" />
        <span v-if="label !== undefined" class="jt-key">{{ label }}</span>
        <span class="jt-size">{{ size }}</span>
        <span v-if="peek" class="jt-peek">{{ peek }}</span>
      </button>
      <div v-if="isOpen" class="jt-children">
        <JsonTree v-for="[key, child] in shown" :key="key" :value="child" :label="Array.isArray(value) ? Number(key) : key" :depth="depth + 1" />
        <button v-if="entries.length > shown.length" type="button" class="jt-more" @click="all = true">{{ t('fairyRecord.moreItems', { n: entries.length - shown.length }) }}</button>
        <div v-if="!entries.length" class="jt-empty">{{ Array.isArray(value) ? '[]' : '{}' }}</div>
      </div>
    </template>
    <div v-else class="jt-row">
      <span v-if="label !== undefined" class="jt-key">{{ label }}</span>
      <span class="jt-leaf" :class="leafClass">{{ leafText(value) }}</span>
    </div>
  </div>
</template>

<style scoped>
.jt {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
}

.jt-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  padding-left: 16px;
}

.jt-toggle {
  position: relative;
  width: 100%;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.jt-toggle:hover .jt-key {
  color: var(--primary);
}

.jt-caret {
  position: absolute;
  left: 0;
  top: 4px;
  font-size: 12px;
  color: var(--fg3);
  transition: transform 0.12s;
}

.jt-caret.open {
  transform: rotate(90deg);
}

.jt-key {
  flex: none;
  color: var(--fg2);
}

.jt-key::after {
  content: ':';
}

.jt-size {
  flex: none;
  color: var(--fg3);
}

.jt-peek {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--fg3);
}

.jt-children {
  margin-left: 5px;
  padding-left: 6px;
  border-left: 1px solid var(--line);
}

.jt-leaf {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.jt-leaf.string {
  color: var(--fg);
}

.jt-leaf.number,
.jt-leaf.boolean {
  color: var(--primary);
}

.jt-leaf.null,
.jt-leaf.undefined,
.jt-empty {
  color: var(--fg3);
}

.jt-empty {
  padding-left: 16px;
}

.jt-more {
  margin: 2px 0 2px 16px;
  padding: 0;
  border: none;
  background: none;
  color: var(--primary);
  font: inherit;
  cursor: pointer;
}
</style>
