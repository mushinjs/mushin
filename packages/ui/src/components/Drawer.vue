<script setup lang="ts">
/**
 * A panel that slides in from an edge of the window, over the page. The default slot is the
 * panel; `title` adds a header with a close button. Classes and styles go to the panel.
 */
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, VisuallyHidden } from 'reka-ui'
import { useText } from '../config'

defineOptions({ inheritAttrs: false })

withDefaults(defineProps<{
  show?: boolean
  title?: string
  /** Names the panel for screen readers when it has no title. */
  label?: string
  placement?: 'left' | 'right'
  /** A width in pixels, or any CSS width. */
  width?: number | string
  closable?: boolean
  maskClosable?: boolean
}>(), { show: false, placement: 'right', width: 360, closable: true, maskClosable: true })

const emit = defineEmits<{ 'update:show': [value: boolean] }>()
const text = useText()
</script>

<template>
  <DialogRoot :open="show" @update:open="(value) => emit('update:show', value)">
    <DialogPortal>
      <DialogOverlay class="mu-modal-mask" />
      <DialogContent
        v-bind="$attrs"
        class="mu-drawer"
        :class="`mu-drawer--${placement}`"
        :style="{ width: typeof width === 'number' ? `${width}px` : width }"
        :aria-describedby="undefined"
        @pointer-down-outside="(event) => !maskClosable && event.preventDefault()"
        @interact-outside="(event) => !maskClosable && event.preventDefault()"
      >
        <header v-if="title" class="mu-drawer__header">
          <DialogTitle class="mu-modal__title">{{ title }}</DialogTitle>
          <DialogClose v-if="closable" class="mu-modal__close" :aria-label="text.close">
            <span class="i-lucide-x" />
          </DialogClose>
        </header>
        <VisuallyHidden v-else-if="label" as-child><DialogTitle>{{ label }}</DialogTitle></VisuallyHidden>
        <div class="mu-drawer__body"><slot /></div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style>
.mu-drawer {
  position: fixed;
  top: 0;
  bottom: 0;
  z-index: 1001;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  max-width: 100vw;
  background: var(--s1);
  color: var(--fg);
  box-shadow: var(--shadow-pop);
}

.mu-drawer:focus { outline: none; }
.mu-drawer--right { right: 0; border-left: 1px solid var(--line); animation: mu-drawer-right 0.2s ease-out; }
.mu-drawer--left { left: 0; border-right: 1px solid var(--line); animation: mu-drawer-left 0.2s ease-out; }
.mu-drawer__header { display: flex; align-items: center; gap: 10px; padding: 16px 20px; border-bottom: 1px solid var(--line); }
.mu-drawer__body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; }

@keyframes mu-drawer-right {
  from { transform: translateX(100%); }
}

@keyframes mu-drawer-left {
  from { transform: translateX(-100%); }
}
</style>
