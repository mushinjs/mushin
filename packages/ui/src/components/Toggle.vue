<script setup lang="ts">
/**
 * An on/off setting, drawn as buttons instead of a sliding switch.
 *
 * - `segmented` (default): two halves, Off | On, the current one filled. For forms, where the
 *   label beside it says what is being turned on.
 * - `button`: one button that reads Enabled or Disabled and is pressed while on. For lists and
 *   table rows, where it has to say its own state.
 */
import { computed } from 'vue'
import { type Size, useText } from '../config'

const props = withDefaults(defineProps<{
  value?: boolean
  size?: Size
  variant?: 'segmented' | 'button'
  loading?: boolean
  disabled?: boolean
  /** Words for the two states; default "On"/"Off" (segmented) or "Enabled"/"Disabled" (button). */
  onLabel?: string
  offLabel?: string
}>(), { value: false, size: 'medium', variant: 'segmented' })

const emit = defineEmits<{ 'update:value': [value: boolean] }>()
const text = useText()
const labels = computed(() => props.variant === 'button'
  ? { on: props.onLabel ?? text.value.enabled, off: props.offLabel ?? text.value.disabled }
  : { on: props.onLabel ?? text.value.on, off: props.offLabel ?? text.value.off })

function set(next: boolean) {
  if (props.disabled || props.loading || next === props.value) return
  emit('update:value', next)
}
</script>

<template>
  <button
    v-if="variant === 'button'"
    type="button"
    role="switch"
    class="mu-toggle-btn"
    :class="[`mu-toggle--${size}`, { 'is-on': value, 'is-busy': loading }]"
    :aria-checked="value"
    :disabled="disabled"
    @click="set(!value)"
  >
    <span v-if="loading" class="i-lucide-loader-circle mu-spin" />
    <span v-else class="mu-toggle-dot" />
    <span>{{ value ? labels.on : labels.off }}</span>
  </button>
  <div
    v-else
    role="radiogroup"
    class="mu-toggle"
    :class="[`mu-toggle--${size}`, { 'is-on': value, 'is-disabled': disabled, 'is-busy': loading }]"
  >
    <button type="button" role="radio" :aria-checked="!value" :disabled="disabled" class="mu-toggle__half" :class="{ 'is-active': !value }" @click="set(false)">
      {{ labels.off }}
    </button>
    <button type="button" role="radio" :aria-checked="value" :disabled="disabled" class="mu-toggle__half mu-toggle__half--on" :class="{ 'is-active': value }" @click="set(true)">
      <span v-if="loading && value" class="i-lucide-loader-circle mu-spin" />
      {{ labels.on }}
    </button>
  </div>
</template>

<style>
.mu-toggle {
  --h: 30px;
  display: inline-flex;
  flex: none;
  box-sizing: border-box;
  height: var(--h);
  padding: 2px;
  gap: 2px;
  border-radius: var(--radius-sm);
  background: var(--s2);
}

.mu-toggle--tiny { --h: 22px; }
.mu-toggle--small { --h: 26px; }
.mu-toggle--large { --h: 36px; }

.mu-toggle__half {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 36px;
  justify-content: center;
  padding: 0 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--fg3);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s, box-shadow 0.15s;
}

.mu-toggle--tiny .mu-toggle__half,
.mu-toggle--small .mu-toggle__half { padding: 0 8px; min-width: 30px; font-size: 12px; }

.mu-toggle__half:not(.is-active):not(:disabled):hover { color: var(--fg); }
.mu-toggle__half:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--focus); }
.mu-toggle__half.is-active { cursor: default; background: var(--raised); color: var(--fg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
.mu-toggle__half--on.is-active { background: var(--primary); color: var(--primary-fg); }
.mu-toggle.is-disabled { opacity: 0.5; }
.mu-toggle.is-disabled .mu-toggle__half { cursor: not-allowed; }
.mu-toggle.is-busy .mu-toggle__half { cursor: progress; }

.mu-toggle-btn {
  --h: 30px;
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  height: var(--h);
  padding: 0 10px 0 9px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--s1);
  color: var(--fg2);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 0.15s, border-color 0.15s, color 0.15s;
}

.mu-toggle-btn.mu-toggle--tiny { --h: 22px; padding: 0 8px 0 7px; gap: 5px; font-size: 12px; }
.mu-toggle-btn.mu-toggle--small { --h: 26px; font-size: 12px; }
.mu-toggle-btn:not(:disabled):hover { border-color: var(--primary); color: var(--fg); }
.mu-toggle-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--focus); }
.mu-toggle-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.mu-toggle-btn.is-busy { cursor: progress; }
.mu-toggle-btn.is-on { border-color: transparent; background: var(--ok-soft); color: var(--ok); }
.mu-toggle-btn.is-on:not(:disabled):hover { border-color: var(--ok); color: var(--ok); }

.mu-toggle-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--idle);
}

.mu-toggle-btn.is-on .mu-toggle-dot { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
</style>
