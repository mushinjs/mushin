<script setup lang="ts">
/** A small label: a status, a type, a count. `closable` adds a remove button. */
import { type Size, type Tone, useText } from '../config'

withDefaults(defineProps<{
  type?: Tone
  size?: Size
  round?: boolean
  /** Outlined instead of filled. */
  bordered?: boolean
  closable?: boolean
  icon?: string
}>(), { type: 'default', size: 'medium', bordered: false })

defineEmits<{ close: [] }>()
const text = useText()
</script>

<template>
  <span class="mu-tag" :class="[`mu-tag--${type}`, `mu-tag--${size}`, { 'mu-tag--round': round, 'mu-tag--bordered': bordered }]">
    <span v-if="icon" class="mu-tag__icon" :class="icon" />
    <slot name="icon" />
    <span class="mu-tag__text"><slot /></span>
    <button v-if="closable" type="button" class="mu-tag__close" :aria-label="text.close" @click.stop="$emit('close')">
      <span class="i-lucide-x" />
    </button>
  </span>
</template>

<style>
.mu-tag {
  --c: var(--fg2);
  --bg: var(--s2);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  max-width: 100%;
  height: 24px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: var(--bg);
  color: var(--c);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  vertical-align: middle;
}

.mu-tag--primary { --c: var(--primary); --bg: var(--primary-soft); }
.mu-tag--info { --c: var(--info); --bg: var(--info-soft); }
.mu-tag--success { --c: var(--ok); --bg: var(--ok-soft); }
.mu-tag--warning { --c: var(--warn); --bg: var(--warn-soft); }
.mu-tag--error { --c: var(--bad); --bg: var(--bad-soft); }
.mu-tag--tiny { height: 18px; padding: 0 5px; font-size: 11px; border-radius: 4px; }
.mu-tag--small { height: 20px; padding: 0 6px; font-size: 11.5px; }
.mu-tag--large { height: 28px; padding: 0 10px; font-size: 13px; }
.mu-tag--round { border-radius: 999px; }
.mu-tag--bordered { background: transparent; border-color: currentColor; }
.mu-tag__text { overflow: hidden; text-overflow: ellipsis; }
.mu-tag__icon { font-size: 1.1em; }

.mu-tag__close {
  display: inline-flex;
  margin-right: -3px;
  padding: 1px;
  border: 0;
  border-radius: 3px;
  background: none;
  color: inherit;
  cursor: pointer;
  opacity: 0.6;
}

.mu-tag__close:hover { opacity: 1; background: rgba(127, 127, 127, 0.18); }
</style>
