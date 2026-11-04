<script setup lang="ts">
/**
 * A button. `type` picks the colour, the style flags how loud it is: solid (default for colours),
 * `secondary` (soft fill), `tertiary` (outline), `quaternary` (no fill until hovered), `dashed`
 * and `text`. An icon goes in `icon` as a class name (`i-lucide-plus`) or in the #icon slot.
 */
import { computed, useSlots } from 'vue'
import type { Size, Tone } from '../config'

const props = withDefaults(defineProps<{
  type?: Tone
  size?: Size
  secondary?: boolean
  tertiary?: boolean
  quaternary?: boolean
  dashed?: boolean
  text?: boolean
  circle?: boolean
  round?: boolean
  block?: boolean
  loading?: boolean
  disabled?: boolean
  icon?: string
  iconPlacement?: 'left' | 'right'
  attrType?: 'button' | 'submit' | 'reset'
  /** Shows the button as pressed, for buttons that toggle something. */
  pressed?: boolean
}>(), { type: 'default', size: 'medium', iconPlacement: 'left', attrType: 'button' })

defineEmits<{ click: [event: MouseEvent] }>()
const slots = useSlots()

// Reka triggers pass type="button" through to their child; that is not a colour.
const TONES = ['default', 'primary', 'info', 'success', 'warning', 'error']
const tone = computed(() => (TONES.includes(props.type) ? props.type : 'default'))
const variant = computed(() => {
  if (props.text) return 'text'
  if (props.quaternary) return 'ghost'
  if (props.dashed) return 'dashed'
  if (props.tertiary) return 'outline'
  if (props.secondary) return 'soft'
  return tone.value === 'default' ? 'outline' : 'solid'
})
const iconOnly = computed(() => !slots.default)
</script>

<template>
  <button
    :type="attrType"
    class="mu-btn"
    :class="[
      `mu-btn--${size}`,
      `mu-btn--${variant}`,
      `mu-tone--${tone}`,
      { 'mu-btn--circle': circle, 'mu-btn--round': round, 'mu-btn--block': block, 'mu-btn--icon-only': iconOnly, 'mu-btn--pressed': pressed, 'mu-btn--loading': loading },
    ]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
    :aria-pressed="pressed === undefined ? undefined : pressed"
    @click="$emit('click', $event)"
  >
    <span v-if="loading" class="mu-btn__icon i-lucide-loader-circle mu-spin" />
    <template v-else-if="iconPlacement === 'left'">
      <span v-if="slots.icon" class="mu-btn__icon"><slot name="icon" /></span>
      <span v-else-if="icon" class="mu-btn__icon" :class="icon" />
    </template>
    <span v-if="slots.default" class="mu-btn__label"><slot /></span>
    <template v-if="!loading && iconPlacement === 'right'">
      <span v-if="slots.icon" class="mu-btn__icon"><slot name="icon" /></span>
      <span v-else-if="icon" class="mu-btn__icon" :class="icon" />
    </template>
  </button>
</template>

<style>
.mu-tone--default { --tone: var(--fg); --tone-hover: var(--fg); --tone-soft: var(--s2); --tone-soft-hover: var(--s3); --tone-fg: var(--s1); }
.mu-tone--primary { --tone: var(--primary); --tone-hover: var(--primary-hover); --tone-soft: var(--primary-soft); --tone-soft-hover: var(--primary-soft-hover); --tone-fg: var(--primary-fg); }
.mu-tone--info { --tone: var(--info); --tone-hover: var(--info); --tone-soft: var(--info-soft); --tone-soft-hover: var(--info-soft); --tone-fg: #fff; }
.mu-tone--success { --tone: var(--ok); --tone-hover: var(--ok); --tone-soft: var(--ok-soft); --tone-soft-hover: var(--ok-soft); --tone-fg: #fff; }
.mu-tone--warning { --tone: var(--warn); --tone-hover: var(--warn); --tone-soft: var(--warn-soft); --tone-soft-hover: var(--warn-soft); --tone-fg: #fff; }
.mu-tone--error { --tone: var(--bad); --tone-hover: var(--bad); --tone-soft: var(--bad-soft); --tone-soft-hover: var(--bad-soft); --tone-fg: #fff; }

.mu-btn {
  --h: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  height: var(--h);
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--tone);
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s;
}

.mu-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--focus);
}

.mu-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.mu-btn--loading:disabled {
  cursor: progress;
  opacity: 0.75;
}

.mu-btn--tiny { --h: 22px; padding: 0 7px; gap: 4px; font-size: 12px; border-radius: 5px; }
.mu-btn--small { --h: 28px; padding: 0 10px; gap: 5px; font-size: 13px; }
.mu-btn--large { --h: 40px; padding: 0 18px; font-size: 15px; }

.mu-btn--icon-only { width: var(--h); padding: 0; }
.mu-btn--circle { border-radius: 999px; }
.mu-btn--round { border-radius: 999px; }
.mu-btn--block { display: flex; width: 100%; }

.mu-btn__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.15em;
}

.mu-btn__icon > svg { width: 1em; height: 1em; }
.mu-btn--tiny .mu-btn__icon { font-size: 13px; }
.mu-btn__label { overflow: hidden; text-overflow: ellipsis; }

.mu-btn--solid { background: var(--tone); color: var(--tone-fg); }
.mu-btn--solid:not(:disabled):hover { background: var(--tone-hover); }
.mu-btn--solid:not(:disabled):active { filter: brightness(0.94); }

.mu-btn--soft { background: var(--tone-soft); }
.mu-btn--soft:not(:disabled):hover { background: var(--tone-soft-hover); }

.mu-btn--outline { border-color: var(--line-strong); background: var(--s1); }
.mu-tone--default.mu-btn--outline { color: var(--fg); }
.mu-btn--outline:not(:disabled):hover { border-color: var(--tone); color: var(--tone); }
.mu-tone--default.mu-btn--outline:not(:disabled):hover { border-color: var(--primary); color: var(--primary); }

.mu-btn--dashed { border: 1px dashed var(--line-strong); }
.mu-tone--default.mu-btn--dashed { color: var(--fg2); }
.mu-btn--dashed:not(:disabled):hover { border-color: var(--primary); color: var(--primary); }

.mu-btn--ghost { color: var(--tone); }
.mu-tone--default.mu-btn--ghost { color: var(--fg2); }
.mu-btn--ghost:not(:disabled):hover { background: var(--tone-soft); }
.mu-tone--default.mu-btn--ghost:not(:disabled):hover { color: var(--fg); background: var(--s2); }

.mu-btn--text { height: auto; padding: 0; border: 0; }
.mu-btn--text:not(:disabled):hover { opacity: 0.8; }
.mu-tone--default.mu-btn--text { color: var(--fg2); }

/* A toggling button that is on: soft colour fill, in every style but solid. */
.mu-btn--pressed:not(.mu-btn--solid) { background: var(--tone-soft); border-color: transparent; }
.mu-tone--default.mu-btn--pressed:not(.mu-btn--solid) { background: var(--primary-soft); color: var(--primary); }

.mu-spin { animation: mu-spin 0.8s linear infinite; }

@keyframes mu-spin {
  to { transform: rotate(360deg); }
}
</style>
