<script setup lang="ts">
/**
 * Tabs over TabPane children: `<Tabs v-model:value="tab"><TabPane name="a" tab="A">…</TabPane></Tabs>`.
 * `type="line"` underlines the current tab; `type="segment"` draws them as a segmented control.
 */
import { TabsIndicator, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import { computed, provide, ref } from 'vue'
import type { Size } from '../config'
import { type PaneInfo, TABS } from './tabs'

const props = withDefaults(defineProps<{
  value?: string
  defaultValue?: string
  type?: 'line' | 'segment'
  size?: Size
  /** Spreads line tabs across the full width. */
  justify?: 'start' | 'stretch'
}>(), { type: 'line', size: 'medium', justify: 'start' })

const emit = defineEmits<{ 'update:value': [value: string] }>()
const panes = ref<PaneInfo[]>([])
const own = ref(props.defaultValue)
const current = computed(() => props.value ?? own.value ?? panes.value[0]?.name)

provide(TABS, {
  register(pane) {
    panes.value.push(pane)
    return () => (panes.value = panes.value.filter((item) => item !== pane))
  },
})

function select(value: string | number) {
  own.value = String(value)
  emit('update:value', String(value))
}
</script>

<template>
  <TabsRoot class="mu-tabs" :class="[`mu-tabs--${type}`, `mu-tabs--${size}`]" :model-value="current" @update:model-value="select">
    <div class="mu-tabs__bar">
      <TabsList class="mu-tabs__list" :class="{ 'mu-tabs__list--stretch': justify === 'stretch' }">
        <TabsIndicator v-if="type === 'line'" class="mu-tabs__indicator" />
        <TabsTrigger v-for="pane in panes" :key="pane.name" class="mu-tabs__tab" :value="pane.name" :disabled="pane.disabled()">
          <span v-if="pane.icon()" :class="pane.icon()" />
          {{ pane.tab() }}
        </TabsTrigger>
      </TabsList>
      <div v-if="$slots.suffix" class="mu-tabs__suffix"><slot name="suffix" /></div>
    </div>
    <slot />
  </TabsRoot>
</template>

<style>
.mu-tabs__bar { display: flex; align-items: center; gap: 8px; }
.mu-tabs__list { position: relative; display: flex; flex: 1; min-width: 0; }
.mu-tabs__suffix { display: flex; align-items: center; gap: 6px; }

.mu-tabs__tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--fg2);
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s, box-shadow 0.15s;
}

.mu-tabs__tab:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--focus); border-radius: 4px; }
.mu-tabs__tab[data-disabled] { opacity: 0.45; cursor: not-allowed; }

/* line */
.mu-tabs--line .mu-tabs__list { gap: 20px; border-bottom: 1px solid var(--line); }
.mu-tabs--line .mu-tabs__list--stretch { gap: 0; }
.mu-tabs--line .mu-tabs__list--stretch .mu-tabs__tab { flex: 1; }
.mu-tabs--line .mu-tabs__tab { height: 40px; }
.mu-tabs--line.mu-tabs--small .mu-tabs__tab { height: 36px; font-size: 13.5px; }
.mu-tabs--line .mu-tabs__tab:hover:not([data-state='active']) { color: var(--fg); }
.mu-tabs--line .mu-tabs__tab[data-state='active'] { color: var(--primary); }

.mu-tabs__indicator {
  position: absolute;
  bottom: -1px;
  left: 0;
  width: var(--reka-tabs-indicator-size);
  height: 2px;
  border-radius: 2px;
  background: var(--primary);
  transform: translateX(var(--reka-tabs-indicator-position));
  transition: width 0.2s, transform 0.2s;
}

/* segment */
.mu-tabs--segment .mu-tabs__list { gap: 2px; padding: 3px; border-radius: var(--radius-sm); background: var(--s2); }
.mu-tabs--segment .mu-tabs__tab { flex: 1; height: 28px; border-radius: 5px; }
.mu-tabs--segment.mu-tabs--small .mu-tabs__tab { height: 26px; font-size: 13px; }
.mu-tabs--segment .mu-tabs__tab:hover:not([data-state='active']) { color: var(--fg); }
.mu-tabs--segment .mu-tabs__tab[data-state='active'] { background: var(--raised); color: var(--fg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
</style>
