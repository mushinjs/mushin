<script setup lang="ts">
import { NIcon, NInput } from 'naive-ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { categories, categoryColors, refOf } from '../../flow'
import type { NodeTypeInfo } from '../../types'
import { localize } from '../../utils'
import { nodeIcon } from './icons'

const props = defineProps<{ types: NodeTypeInfo[] }>()
const emit = defineEmits<{ add: [typeId: string] }>()
const { t, locale } = useI18n()
const query = ref('')

const groups = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return categories
    .map((category) => ({
      category,
      items: props.types.filter((type) => type.category === category && (!needle
        || `${type.type} ${localize(type.title, locale.value)} ${localize(type.description, locale.value)}`.toLowerCase().includes(needle))),
    }))
    .filter((group) => group.items.length)
})

function onDragStart(event: DragEvent, typeId: string) {
  event.dataTransfer?.setData('application/mushin-node', typeId)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
</script>

<template>
  <aside class="palette">
    <NInput v-model:value="query" size="small" clearable :placeholder="t('flows.searchNodes')" />
    <div v-for="group in groups" :key="group.category" class="group">
      <div class="group-title" :style="{ color: categoryColors[group.category] }">{{ t(`flows.category.${group.category}`) }}</div>
      <button
        v-for="type in group.items"
        :key="type.type"
        type="button"
        class="item"
        draggable="true"
        :title="localize(type.description, locale)"
        :style="{ '--accent': categoryColors[type.category] }"
        @dragstart="onDragStart($event, type.type)"
        @click="emit('add', type.type)"
      >
        <span class="item-icon"><NIcon :size="14"><component :is="nodeIcon(type.type, type.category)" /></NIcon></span>
        <span class="item-title">{{ localize(type.title, locale) }}</span>
      </button>
    </div>
    <p class="hint">{{ t('flows.paletteHint', { ref: refOf('n1', 'text') }) }}</p>
  </aside>
</template>

<style scoped>
.palette {
  width: 190px;
  flex: none;
  overflow-y: auto;
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
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
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
