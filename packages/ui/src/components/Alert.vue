<script setup lang="ts">
/** A note inside a page or panel: information, a warning, an error. */
import { computed } from 'vue'
import { type Tone, useText } from '../config'

const props = withDefaults(defineProps<{
  type?: Tone
  title?: string
  showIcon?: boolean
  closable?: boolean
}>(), { type: 'info', showIcon: true })

defineEmits<{ close: [] }>()
const text = useText()
const icon = computed(() => ({
  default: 'i-lucide-info',
  primary: 'i-lucide-info',
  info: 'i-lucide-info',
  success: 'i-lucide-circle-check',
  warning: 'i-lucide-triangle-alert',
  error: 'i-lucide-circle-x',
}[props.type]))
</script>

<template>
  <div class="mu-alert" :class="`mu-alert--${type}`" :role="type === 'error' || type === 'warning' ? 'alert' : 'status'">
    <span v-if="showIcon" class="mu-alert__icon" :class="icon" />
    <div class="mu-alert__body">
      <div v-if="title || $slots.header" class="mu-alert__title"><slot name="header">{{ title }}</slot></div>
      <div v-if="$slots.default" class="mu-alert__content"><slot /></div>
    </div>
    <button v-if="closable" type="button" class="mu-alert__close" :aria-label="text.close" @click="$emit('close')">
      <span class="i-lucide-x" />
    </button>
  </div>
</template>

<style>
.mu-alert {
  --c: var(--info);
  --bg: var(--info-soft);
  display: flex;
  align-items: flex-start;
  gap: 8px;
  box-sizing: border-box;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
  line-height: 1.55;
}

.mu-alert--default { --c: var(--fg2); --bg: var(--s2); }
.mu-alert--primary { --c: var(--primary); --bg: var(--primary-soft); }
.mu-alert--success { --c: var(--ok); --bg: var(--ok-soft); }
.mu-alert--warning { --c: var(--warn); --bg: var(--warn-soft); }
.mu-alert--error { --c: var(--bad); --bg: var(--bad-soft); }
.mu-alert__icon { margin-top: 2px; color: var(--c); font-size: 16px; }
.mu-alert__body { flex: 1; min-width: 0; }
.mu-alert__title { font-weight: 600; }
.mu-alert__title + .mu-alert__content { margin-top: 2px; color: var(--fg2); }

.mu-alert__close {
  display: inline-flex;
  padding: 2px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--fg3);
  cursor: pointer;
}

.mu-alert__close:hover { color: var(--fg); }
</style>
