<script setup lang="ts">
/**
 * A text field, or a multi-line one with `type="textarea"`. Classes, styles and `data-*` attributes
 * go on the outer box; listeners and other attributes on the <input> or <textarea> itself.
 */
import { computed, nextTick, onMounted, ref, useAttrs, watch } from 'vue'
import { type Size, useText } from '../config'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  value?: string | null
  type?: 'text' | 'password' | 'textarea'
  size?: Size
  placeholder?: string
  clearable?: boolean
  disabled?: boolean
  readonly?: boolean
  /** Shows an eye button on password fields. */
  showPasswordOn?: 'click'
  /** Textarea height in rows; grows with the text between the two. */
  autosize?: boolean | { minRows?: number; maxRows?: number }
  rows?: number
  maxlength?: number
  /** Extra attributes for the <input> or <textarea>. */
  inputProps?: Record<string, unknown>
  status?: 'error' | 'warning'
}>(), { type: 'text', size: 'medium' })

const emit = defineEmits<{ 'update:value': [value: string]; clear: [] }>()
const attrs = useAttrs()
const text = useText()
const field = ref<HTMLInputElement | HTMLTextAreaElement>()
const reveal = ref(false)

const outer = computed(() => {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attrs)) if (key === 'class' || key === 'style' || key.startsWith('data-')) result[key] = value
  return result
})
const inner = computed(() => {
  const result: Record<string, unknown> = { ...props.inputProps }
  for (const [key, value] of Object.entries(attrs)) if (!(key === 'class' || key === 'style' || key.startsWith('data-'))) result[key] = value
  return result
})

function onInput(event: Event) {
  emit('update:value', (event.target as HTMLInputElement).value)
  if (props.type === 'textarea') resize()
}

function clear() {
  emit('update:value', '')
  emit('clear')
  field.value?.focus()
}

function resize() {
  const el = field.value
  if (!(el instanceof HTMLTextAreaElement) || !props.autosize) return
  const { minRows = 1, maxRows = Infinity } = typeof props.autosize === 'object' ? props.autosize : {}
  const style = getComputedStyle(el)
  const line = Number.parseFloat(style.lineHeight) || 20
  const extra = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
  el.style.height = 'auto'
  const height = Math.min(Math.max(el.scrollHeight, minRows * line + extra), maxRows * line + extra)
  el.style.height = `${height}px`
  el.style.overflowY = el.scrollHeight > height ? 'auto' : 'hidden'
}

watch(() => props.value, () => nextTick(resize))
onMounted(resize)

defineExpose({ focus: () => field.value?.focus(), blur: () => field.value?.blur(), select: () => field.value?.select(), el: field })
</script>

<template>
  <div
    v-bind="outer"
    class="mu-input"
    :class="[`mu-input--${size}`, { 'mu-input--textarea': type === 'textarea', 'is-disabled': disabled, [`is-${status}`]: status }]"
  >
    <span v-if="$slots.prefix" class="mu-input__affix"><slot name="prefix" /></span>
    <textarea
      v-if="type === 'textarea'"
      ref="field"
      v-bind="inner"
      class="mu-input__field"
      :value="value ?? ''"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :rows="rows ?? (typeof autosize === 'object' ? autosize.minRows : undefined) ?? 3"
      :maxlength="maxlength"
      @input="onInput"
    />
    <input
      v-else
      ref="field"
      v-bind="inner"
      class="mu-input__field"
      :type="type === 'password' && !reveal ? 'password' : 'text'"
      :value="value ?? ''"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :maxlength="maxlength"
      @input="onInput"
    >
    <button
      v-if="clearable && value && !disabled && !readonly"
      type="button"
      class="mu-input__clear"
      tabindex="-1"
      :aria-label="text.clear"
      @click="clear"
    >
      <span class="i-lucide-circle-x" />
    </button>
    <button
      v-if="type === 'password' && showPasswordOn"
      type="button"
      class="mu-input__clear"
      tabindex="-1"
      :aria-pressed="reveal"
      @click="reveal = !reveal"
    >
      <span :class="reveal ? 'i-lucide-eye-off' : 'i-lucide-eye'" />
    </button>
    <span v-if="$slots.suffix" class="mu-input__affix"><slot name="suffix" /></span>
  </div>
</template>

<style>
.mu-input {
  --h: 34px;
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  width: 100%;
  min-height: var(--h);
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--s2);
  color: var(--fg);
  font-size: 14px;
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s;
}

.mu-input--tiny { --h: 22px; padding: 0 6px; font-size: 12px; border-radius: 5px; }
.mu-input--small { --h: 28px; padding: 0 8px; font-size: 13px; }
.mu-input--large { --h: 40px; font-size: 15px; }
.mu-input:hover { border-color: var(--line-strong); }
.mu-input:focus-within { border-color: var(--primary); background: var(--s1); box-shadow: 0 0 0 3px var(--focus); }
.mu-input.is-error { border-color: var(--bad); }
.mu-input.is-error:focus-within { box-shadow: 0 0 0 3px var(--bad-soft); }
.mu-input.is-warning { border-color: var(--warn); }
.mu-input.is-disabled { opacity: 0.6; cursor: not-allowed; }
.mu-input--textarea { align-items: flex-start; padding-top: 0; padding-bottom: 0; }

.mu-input__field {
  flex: 1;
  min-width: 0;
  height: calc(var(--h) - 2px);
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
}

.mu-input__field::placeholder { color: var(--fg3); }
.mu-input__field:disabled { cursor: not-allowed; }

textarea.mu-input__field {
  height: auto;
  padding: 6px 0;
  line-height: 1.55;
  resize: vertical;
}

.mu-input__affix {
  display: inline-flex;
  align-items: center;
  color: var(--fg3);
}

.mu-input__clear {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: 0;
  background: none;
  color: var(--fg3);
  font-size: 14px;
  cursor: pointer;
}

.mu-input__clear:hover { color: var(--fg2); }
.mu-input--textarea .mu-input__clear { margin-top: 8px; }
</style>
