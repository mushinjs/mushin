<script setup lang="ts">
import { NIcon, NInput, useThemeVars } from 'naive-ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { categories, categoryColors, supports } from '../../flow'
import type { NodeTypeInfo } from '../../types'
import { localize } from '../../utils'
import { nodeIcon } from './icons'

/**
 * A searchable node list that floats at a point on the canvas: opened from the context menu, or
 * when a connection is dropped on empty canvas (then only nodes that can connect there are listed).
 */
const props = defineProps<{
  types: NodeTypeInfo[]
  /** Where to show it, in page coordinates. */
  x: number
  y: number
  title?: string
  adapter?: string
  adapterName: (id: string) => string
}>()
const emit = defineEmits<{ pick: [typeId: string]; close: [] }>()
const { t, locale } = useI18n()
const query = ref('')
const root = ref<HTMLElement>()
const search = ref<InstanceType<typeof NInput>>()
const active = ref(0)
const theme = useThemeVars()

const usable = (type: NodeTypeInfo) => supports(type, props.adapter)

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
/** Items that can be picked, in display order, for keyboard navigation. */
const flat = computed(() => groups.value.flatMap((group) => group.items).filter(usable))

function hint(type: NodeTypeInfo) {
  const description = localize(type.description, locale.value)
  if (usable(type)) return description
  const reason = t('flows.nodeNeedsAdapter', {
    name: (type.platforms ?? []).map(props.adapterName).join(' / '),
    current: props.adapterName(props.adapter ?? ''),
  })
  return description ? `${reason}\n${description}` : reason
}

function pick(type: NodeTypeInfo) {
  if (usable(type)) emit('pick', type.type)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
  else if (event.key === 'ArrowDown') active.value = Math.min(active.value + 1, flat.value.length - 1)
  else if (event.key === 'ArrowUp') active.value = Math.max(active.value - 1, 0)
  else if (event.key === 'Enter' && flat.value[active.value]) pick(flat.value[active.value])
  else return
  event.preventDefault()
  nextTick(() => root.value?.querySelector('.item.active')?.scrollIntoView({ block: 'nearest' }))
}

// Stay inside the window.
const style = computed(() => ({
  left: `${Math.max(8, Math.min(props.x, window.innerWidth - 268))}px`,
  top: `${Math.max(8, Math.min(props.y, window.innerHeight - 388))}px`,
  background: theme.value.popoverColor,
  color: theme.value.textColor2,
}))

function onPointerDown(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) emit('close')
}
onMounted(() => {
  // A later tick, so the click that opened the picker does not close it.
  setTimeout(() => {
    window.addEventListener('pointerdown', onPointerDown, true)
    search.value?.focus()
  }, 30)
})
onBeforeUnmount(() => window.removeEventListener('pointerdown', onPointerDown, true))
</script>

<template>
  <!-- On the body: a transformed ancestor would offset position: fixed. -->
  <Teleport to="body">
    <div ref="root" class="picker" :style="style" @keydown="onKeydown" @contextmenu.prevent>
      <div v-if="title" class="picker-title">{{ title }}</div>
      <NInput ref="search" v-model:value="query" size="small" clearable :placeholder="t('flows.searchNodes')" @update:value="active = 0" />
      <div class="list">
        <template v-for="group in groups" :key="group.category">
          <div class="group-title" :style="{ color: categoryColors[group.category] }">{{ t(`flows.category.${group.category}`) }}</div>
          <button
            v-for="type in group.items"
            :key="type.type"
            type="button"
            class="item"
            :class="{ unavailable: !usable(type), active: flat[active] === type }"
            :aria-disabled="!usable(type)"
            :title="hint(type)"
            :style="{ '--accent': categoryColors[type.category] }"
            @mouseenter="usable(type) && (active = flat.indexOf(type))"
            @click="pick(type)"
          >
            <span class="item-icon"><NIcon :size="13"><component :is="nodeIcon(type.type, type.category)" /></NIcon></span>
            <span class="item-title">{{ localize(type.title, locale) }}</span>
          </button>
        </template>
        <p v-if="!groups.length" class="empty">{{ t('flows.pickerEmpty') }}</p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.picker {
  position: fixed;
  z-index: 2000;
  width: 260px;
  max-height: 380px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: 10px;
  border: 1px solid rgba(127, 127, 127, 0.25);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
}

.picker-title {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.7;
  padding: 0 2px;
}

.list {
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.group-title {
  margin: 6px 2px 2px;
  font-size: 11px;
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
  padding: 4px 6px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.item.active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.item.unavailable {
  opacity: 0.42;
  filter: grayscale(1);
  cursor: not-allowed;
}

.item-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
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

.empty {
  margin: 8px 2px;
  font-size: 12px;
  opacity: 0.6;
}
</style>
