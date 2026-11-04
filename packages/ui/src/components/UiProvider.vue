<script setup lang="ts">
/**
 * Wraps the app once: passes the host's words to the components and draws toasts and
 * confirmation dialogs (see feedback.ts).
 */
import {
  AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogOverlay, AlertDialogPortal, AlertDialogRoot,
  AlertDialogTitle, TooltipProvider,
} from 'reka-ui'
import { provideText, type UiText, useText } from '../config'
import { type Confirm, feedback } from '../feedback'
import Button from './Button.vue'

const props = defineProps<{ text?: Partial<UiText> }>()
provideText(() => props.text)
const words = useText()

const toastIcon = {
  info: 'i-lucide-info',
  success: 'i-lucide-circle-check',
  warning: 'i-lucide-triangle-alert',
  error: 'i-lucide-circle-x',
  loading: 'i-lucide-loader-circle mu-spin',
}
const confirmIcon = { info: 'i-lucide-info', success: 'i-lucide-circle-check', warning: 'i-lucide-triangle-alert', error: 'i-lucide-circle-alert' }

function close(item: Confirm) {
  const index = feedback.confirms.indexOf(item)
  if (index >= 0) feedback.confirms.splice(index, 1)
  item.onClose?.()
}

async function positive(item: Confirm) {
  item.loading = true
  try {
    if ((await item.onPositiveClick?.()) === false) return
    close(item)
  } finally {
    item.loading = false
  }
}

async function negative(item: Confirm) {
  if ((await item.onNegativeClick?.()) === false) return
  close(item)
}

function removeToast(id: number) {
  const index = feedback.toasts.findIndex((item) => item.id === id)
  if (index >= 0) feedback.toasts.splice(index, 1)
}
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <slot />
  </TooltipProvider>

  <Teleport to="body">
    <TransitionGroup tag="div" name="mu-toast" class="mu-toasts" aria-live="polite">
      <div v-for="item in feedback.toasts" :key="item.id" class="mu-toast" :class="`mu-toast--${item.type}`" :role="item.type === 'error' ? 'alert' : 'status'">
        <span class="mu-toast__icon" :class="toastIcon[item.type]" />
        <span class="mu-toast__text">{{ item.content }}</span>
        <button v-if="item.closable" type="button" class="mu-toast__close" :aria-label="words.close" @click="removeToast(item.id)">
          <span class="i-lucide-x" />
        </button>
      </div>
    </TransitionGroup>
  </Teleport>

  <AlertDialogRoot v-for="item in feedback.confirms" :key="item.id" :open="true" @update:open="(open) => !open && negative(item)">
    <AlertDialogPortal>
      <AlertDialogOverlay class="mu-modal-mask" @click="item.maskClosable !== false && negative(item)" />
      <AlertDialogContent class="mu-modal mu-confirm" :class="`mu-confirm--${item.type}`" :style="{ width: '420px' }">
        <div class="mu-confirm__head">
          <span class="mu-confirm__icon" :class="confirmIcon[item.type]" />
          <AlertDialogTitle class="mu-modal__title">{{ item.title }}</AlertDialogTitle>
        </div>
        <AlertDialogDescription v-if="item.content" class="mu-confirm__body">{{ item.content }}</AlertDialogDescription>
        <div class="mu-modal__footer">
          <AlertDialogCancel v-if="item.negativeText !== ''" as-child @click.prevent="negative(item)">
            <Button size="small">{{ item.negativeText ?? words.cancel }}</Button>
          </AlertDialogCancel>
          <AlertDialogAction as-child @click.prevent="positive(item)">
            <Button size="small" :type="item.type === 'warning' || item.type === 'error' ? 'error' : 'primary'" :loading="item.loading">
              {{ item.positiveText ?? words.ok }}
            </Button>
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>

<style>
.mu-toasts {
  position: fixed;
  top: 16px;
  left: 50%;
  z-index: 4000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  transform: translateX(-50%);
  pointer-events: none;
}

.mu-toast {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(520px, calc(100vw - 32px));
  padding: 9px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--s1);
  color: var(--fg);
  font-size: 13.5px;
  line-height: 1.5;
  box-shadow: var(--shadow-pop);
  pointer-events: auto;
}

.mu-toast__icon { font-size: 16px; }
.mu-toast--info .mu-toast__icon { color: var(--info); }
.mu-toast--success .mu-toast__icon { color: var(--ok); }
.mu-toast--warning .mu-toast__icon { color: var(--warn); }
.mu-toast--error .mu-toast__icon { color: var(--bad); }
.mu-toast--loading .mu-toast__icon { color: var(--primary); }
.mu-toast__text { overflow-wrap: anywhere; }

.mu-toast__close {
  display: inline-flex;
  padding: 2px;
  border: 0;
  background: none;
  color: var(--fg3);
  cursor: pointer;
}

.mu-toast-enter-active,
.mu-toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.mu-toast-enter-from,
.mu-toast-leave-to { opacity: 0; transform: translateY(-8px); }

.mu-confirm { padding-top: 20px; }
.mu-confirm__head { display: flex; align-items: center; gap: 10px; padding: 0 20px; }
.mu-confirm__icon { font-size: 20px; }
.mu-confirm--info .mu-confirm__icon { color: var(--info); }
.mu-confirm--success .mu-confirm__icon { color: var(--ok); }
.mu-confirm--warning .mu-confirm__icon { color: var(--warn); }
.mu-confirm--error .mu-confirm__icon { color: var(--bad); }
.mu-confirm__body { margin: 0; padding: 10px 20px 20px 50px; color: var(--fg2); font-size: 14px; line-height: 1.6; white-space: pre-line; }
</style>
