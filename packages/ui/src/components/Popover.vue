<script setup lang="ts">
/** A floating panel opened by clicking its #trigger; the default slot is the panel. */
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'

// Classes and styles style the panel, as they did on Naive UI's popover.
defineOptions({ inheritAttrs: false })

withDefaults(defineProps<{
  show?: boolean
  placement?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  width?: number | 'trigger'
  /** Padding inside the panel; turn off for menus and lists that pad themselves. */
  padded?: boolean
  /** Leaves focus where it is when the panel opens, for panels that only show information. */
  keepFocus?: boolean
}>(), { show: undefined, placement: 'bottom', align: 'start', padded: true })

defineEmits<{ 'update:show': [value: boolean] }>()
</script>

<template>
  <PopoverRoot :open="show" @update:open="(value) => $emit('update:show', value)">
    <PopoverTrigger as-child>
      <slot name="trigger" />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        v-bind="$attrs"
        class="mu-pop"
        :class="{ 'mu-pop--padded': padded }"
        :side="placement"
        :align="align"
        :side-offset="6"
        :collision-padding="8"
        :style="width === 'trigger' ? { width: 'var(--reka-popover-trigger-width)' } : width ? { width: `${width}px` } : undefined"
        @open-auto-focus="(event: Event) => keepFocus && event.preventDefault()"
        @close-auto-focus="(event: Event) => keepFocus && event.preventDefault()"
      >
        <slot />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style>
.mu-pop {
  z-index: 2000;
  box-sizing: border-box;
  max-width: calc(100vw - 16px);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
  color: var(--fg);
  font-size: 14px;
  box-shadow: var(--shadow-pop);
  animation: mu-fade-in 0.12s ease-out;
}

.mu-pop--padded { padding: 12px 14px; }
.mu-pop:focus { outline: none; }
</style>
