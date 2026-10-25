<script setup lang="ts">
import { ChevronDownOutline } from '@vicons/ionicons5'
import { NIcon, NInput } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { categories, categoryColors, refOf, supports } from '../../flow'
import type { NodeCategory, NodeTypeInfo } from '../../types'
import { localize } from '../../utils'
import { nodeIcon } from './icons'

const props = defineProps<{
  types: NodeTypeInfo[]
  /** The flow's adapter; nodes for other adapters are greyed out. */
  adapter?: string
  /** An adapter id's display name, for the hint on greyed-out nodes. */
  adapterName: (id: string) => string
}>()
const emit = defineEmits<{ add: [typeId: string] }>()
const { t, locale } = useI18n()
const query = ref('')

// Collapsed categories are remembered in this browser only.
const STORAGE_KEY = 'mushin.flows.collapsed'
function readCollapsed() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return new Set<NodeCategory>(Array.isArray(value) ? value : [])
  } catch {
    return new Set<NodeCategory>()
  }
}
const collapsed = ref(readCollapsed())
watch(collapsed, (value) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...value]))
  } catch {}
})

function toggle(category: NodeCategory) {
  const next = new Set(collapsed.value)
  if (next.has(category)) next.delete(category)
  else next.add(category)
  collapsed.value = next
}

const groups = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return categories
    .map((category) => ({
      category,
      // While searching every match shows, collapsed or not.
      open: !!needle || !collapsed.value.has(category),
      items: props.types.filter((type) => type.category === category && (!needle
        || `${type.type} ${localize(type.title, locale.value)} ${localize(type.description, locale.value)}`.toLowerCase().includes(needle))),
    }))
    .filter((group) => group.items.length)
})

const usable = (type: NodeTypeInfo) => supports(type, props.adapter)

/** The tooltip: the description, and for greyed-out nodes why they are unavailable. */
function hint(type: NodeTypeInfo) {
  const description = localize(type.description, locale.value)
  if (usable(type)) return description
  const reason = t('flows.nodeNeedsAdapter', {
    name: (type.platforms ?? []).map(props.adapterName).join(' / '),
    current: props.adapterName(props.adapter ?? ''),
  })
  return description ? `${reason}\n${description}` : reason
}

function onDragStart(event: DragEvent, type: NodeTypeInfo) {
  if (!usable(type)) {
    event.preventDefault()
    return
  }
  event.dataTransfer?.setData('application/mushin-node', type.type)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onClick(type: NodeTypeInfo) {
  if (usable(type)) emit('add', type.type)
}
</script>

<template>
  <aside class="palette">
    <NInput v-model:value="query" size="small" clearable :placeholder="t('flows.searchNodes')" />
    <div v-for="group in groups" :key="group.category" class="group">
      <button
        type="button"
        class="group-title"
        :class="{ closed: !group.open }"
        :style="{ color: categoryColors[group.category] }"
        :aria-expanded="group.open"
        @click="toggle(group.category)"
      >
        <NIcon :size="12" class="chevron"><ChevronDownOutline /></NIcon>
        <span class="group-name">{{ t(`flows.category.${group.category}`) }}</span>
        <span class="group-count">{{ group.items.length }}</span>
      </button>
      <template v-if="group.open">
        <!-- Greyed-out nodes use aria-disabled rather than disabled, so hovering still shows why. -->
        <button
          v-for="type in group.items"
          :key="type.type"
          type="button"
          class="item"
          :class="{ unavailable: !usable(type) }"
          :draggable="usable(type)"
          :aria-disabled="!usable(type)"
          :title="hint(type)"
          :style="{ '--accent': categoryColors[type.category] }"
          @dragstart="onDragStart($event, type)"
          @click="onClick(type)"
        >
          <span class="item-icon"><NIcon :size="14"><component :is="nodeIcon(type.type, type.category)" /></NIcon></span>
          <span class="item-title">{{ localize(type.title, locale) }}</span>
        </button>
      </template>
    </div>
    <p class="hint">{{ t('flows.paletteHint', { ref: refOf('n1', 'text') }) }}</p>
  </aside>
</template>

<style scoped>
.palette {
  width: 190px;
  flex: none;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 12px;
  border-right: 1px solid rgba(127, 127, 127, 0.18);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}

.group-title {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  text-align: left;
  cursor: pointer;
}

.chevron {
  transition: transform 0.15s;
}

.group-title.closed .chevron {
  transform: rotate(-90deg);
}

.group-name {
  flex: 1;
}

.group-count {
  font-weight: 500;
  letter-spacing: 0;
  opacity: 0.55;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  font: inherit;
  font-size: 13px;
  padding: 5px 8px 5px 5px;
  border-radius: 8px;
  border: 1px solid rgba(127, 127, 127, 0.22);
  background: transparent;
  color: inherit;
  cursor: grab;
}

.item:hover {
  background: rgba(127, 127, 127, 0.08);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
}

.item.unavailable {
  opacity: 0.42;
  filter: grayscale(1);
  cursor: not-allowed;
}

.item.unavailable:hover {
  background: transparent;
  border-color: rgba(127, 127, 127, 0.22);
}

.item-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--accent-fg, var(--accent));
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}

.item-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint {
  margin: 12px 0 0;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.5;
}
</style>
