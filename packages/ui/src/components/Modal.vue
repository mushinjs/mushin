<script setup lang="ts">
/**
 * A dialog over the page: title, body (default slot), and buttons in #footer. `bare` drops the
 * frame, for dialogs that draw their own (such as a search box); name those with `label`.
 * Classes, styles and other attributes go to the dialog.
 */
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, VisuallyHidden } from 'reka-ui'
import { useText } from '../config'

defineOptions({ inheritAttrs: false })

withDefaults(defineProps<{
  show?: boolean
  title?: string
  /** A width in pixels, or any CSS width. */
  width?: number | string
  closable?: boolean
  maskClosable?: boolean
  description?: string
  bare?: boolean
  /** Names a dialog without a title for screen readers. */
  label?: string
}>(), { show: false, width: 520, closable: true, maskClosable: true })

const emit = defineEmits<{ 'update:show': [value: boolean]; afterLeave: [] }>()
const text = useText()
</script>

<template>
  <DialogRoot :open="show" @update:open="(value) => emit('update:show', value)">
    <DialogPortal>
      <DialogOverlay class="mu-modal-mask" />
      <DialogContent
        v-bind="description && !bare ? $attrs : { 'aria-describedby': undefined, ...$attrs }"
        class="mu-modal"
        :class="{ 'mu-modal--bare': bare }"
        :style="bare ? undefined : { width: typeof width === 'number' ? `${width}px` : width }"
        @pointer-down-outside="(event) => !maskClosable && event.preventDefault()"
        @interact-outside="(event) => !maskClosable && event.preventDefault()"
      >
        <template v-if="bare">
          <VisuallyHidden as-child><DialogTitle>{{ label ?? title }}</DialogTitle></VisuallyHidden>
          <slot />
        </template>
        <header v-else-if="title || $slots.header || closable" class="mu-modal__header">
          <DialogTitle class="mu-modal__title"><slot name="header">{{ title }}</slot></DialogTitle>
          <slot name="header-extra" />
          <DialogClose v-if="closable" class="mu-modal__close" :aria-label="text.close">
            <span class="i-lucide-x" />
          </DialogClose>
        </header>
        <DialogDescription v-if="description && !bare" class="mu-modal__desc">{{ description }}</DialogDescription>
        <div v-if="!bare" class="mu-modal__body"><slot /></div>
        <footer v-if="$slots.footer && !bare" class="mu-modal__footer"><slot name="footer" /></footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style>
.mu-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: var(--overlay);
  animation: mu-mask-in 0.15s ease-out;
}

.mu-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 1001;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 48px);
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--s1);
  color: var(--fg);
  box-shadow: var(--shadow-pop);
  transform: translate(-50%, -50%);
  animation: mu-modal-in 0.16s ease-out;
}

.mu-modal:focus { outline: none; }
.mu-modal--bare { max-height: none; border: 0; border-radius: 0; background: none; box-shadow: none; }

.mu-modal__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 20px 0;
}

.mu-modal__title { flex: 1; min-width: 0; margin: 0; font-size: 16px; font-weight: 600; }

.mu-modal__close {
  display: inline-flex;
  padding: 4px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--fg3);
  font-size: 16px;
  cursor: pointer;
}

.mu-modal__close:hover { background: var(--s2); color: var(--fg); }
.mu-modal__desc { margin: 6px 20px 0; color: var(--fg2); font-size: 13px; }
.mu-modal__body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px 20px; font-size: 14px; line-height: 1.6; }

.mu-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 20px 18px;
}

@keyframes mu-mask-in {
  from { opacity: 0; }
}

@keyframes mu-modal-in {
  from { opacity: 0; transform: translate(-50%, calc(-50% + 8px)) scale(0.98); }
}
</style>
