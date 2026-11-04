<script setup lang="ts">
/**
 * A dropdown choice. One component covers what the dashboard needs:
 * - `filterable`: type to narrow the list.
 * - `tag`: typed text that matches no option can be chosen as it is.
 * - `multiple`: several values, shown as tags (`maxTagCount` folds the rest into "+N").
 * - Options in groups: `{ type: 'group', key, label, children }`.
 * The #option slot draws an option's label; it gets `{ option }`. The #tag slot draws a chosen
 * value's tag in a multiple select; it gets `{ value, label }`.
 */
import {
  ComboboxAnchor, ComboboxContent, ComboboxGroup, ComboboxInput, ComboboxItem, ComboboxItemIndicator, ComboboxLabel, ComboboxPortal, ComboboxRoot,
  ComboboxTrigger, ComboboxViewport,
} from 'reka-ui'
import { computed, ref, useAttrs } from 'vue'
import { type Size, useText } from '../config'

type Value = string | number

export interface SelectOption {
  label: string
  value: Value
  disabled?: boolean
  /** Muted text after the label. */
  description?: string
  [key: string]: unknown
}

export interface SelectGroup {
  type: 'group'
  key: string
  label: string
  children: SelectOption[]
}

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  value?: Value | Value[] | null
  options?: (SelectOption | SelectGroup)[]
  multiple?: boolean
  filterable?: boolean
  tag?: boolean
  clearable?: boolean
  placeholder?: string
  size?: Size
  disabled?: boolean
  loading?: boolean
  maxTagCount?: number | 'responsive'
  status?: 'error' | 'warning'
}>(), { options: () => [], size: 'medium' })

const emit = defineEmits<{ 'update:value': [value: any]; blur: []; focus: [] }>()
const text = useText()

// Classes, styles and data-* attributes size and place the whole field; the rest go to the box.
const attrs = useAttrs()
const outer = computed(() => Object.fromEntries(Object.entries(attrs).filter(([key]) => key === 'class' || key === 'style' || key.startsWith('data-'))))
const inner = computed(() => Object.fromEntries(Object.entries(attrs).filter(([key]) => !(key === 'class' || key === 'style' || key.startsWith('data-')))))

const open = ref(false)
const search = ref('')
const typed = ref(false)

const isGroup = (item: SelectOption | SelectGroup): item is SelectGroup => (item as SelectGroup).type === 'group'
const flat = computed(() => props.options.flatMap((item) => (isGroup(item) ? item.children : [item])))
const byValue = computed(() => new Map(flat.value.map((option) => [option.value, option])))
const labelOf = (value: Value | null | undefined) => (value === null || value === undefined || value === '' ? '' : byValue.value.get(value)?.label ?? String(value))

const selected = computed<Value[]>(() => (props.multiple ? (Array.isArray(props.value) ? props.value : []) : props.value === null || props.value === undefined || props.value === '' ? [] : [props.value as Value]))
const tagLimit = computed(() => (props.maxTagCount === 'responsive' ? 2 : props.maxTagCount))
const shownTags = computed(() => (tagLimit.value === undefined ? selected.value : selected.value.slice(0, tagLimit.value)))

const query = computed(() => (typed.value ? search.value.trim().toLowerCase() : ''))
const matches = (option: SelectOption) => !query.value || option.label.toLowerCase().includes(query.value) || String(option.value).toLowerCase().includes(query.value)
const visible = computed(() => props.options
  .map((item) => (isGroup(item) ? { ...item, children: item.children.filter(matches) } : item))
  .filter((item) => (isGroup(item) ? item.children.length > 0 : matches(item))))
const custom = computed(() => {
  const value = search.value.trim()
  if (!props.tag || !typed.value || !value) return
  if (flat.value.some((option) => option.label === value || String(option.value) === value)) return
  return value
})
const empty = computed(() => !custom.value && visible.value.length === 0)

function choose(next: unknown) {
  typed.value = false
  search.value = ''
  if (props.multiple) emit('update:value', Array.isArray(next) ? next : [])
  else emit('update:value', next ?? null)
}

function remove(value: Value) {
  emit('update:value', selected.value.filter((item) => item !== value))
}

function clear() {
  emit('update:value', props.multiple ? [] : null)
}

function onInput(event: Event) {
  search.value = (event.target as HTMLInputElement).value
  typed.value = true
  open.value = true
}

// Typing replaces the chosen label instead of adding to it.
function onFocus(event: FocusEvent) {
  if (editable.value && !props.multiple) (event.target as HTMLInputElement).select()
  emit('focus')
}

function onOpen(value: boolean) {
  open.value = value
  if (!value) {
    typed.value = false
    search.value = ''
  }
}

// Backspace in an empty multi-select takes off the last tag.
function onKeydown(event: KeyboardEvent) {
  if (props.multiple && event.key === 'Backspace' && !search.value && selected.value.length) remove(selected.value[selected.value.length - 1])
}

const editable = computed(() => props.filterable || props.tag)
const showClear = computed(() => props.clearable && !props.disabled && selected.value.length > 0)
</script>

<template>
  <div v-bind="outer" class="mu-select-root">
    <ComboboxRoot
      :model-value="(multiple ? selected : selected[0] ?? null) as any"
      :multiple="multiple"
      :disabled="disabled"
      :open="open"
      ignore-filter
      open-on-click
      :reset-search-term-on-blur="!multiple"
      :reset-search-term-on-select="true"
      class="mu-select-state"
      @update:model-value="choose"
      @update:open="onOpen"
    >
      <ComboboxAnchor
        v-bind="inner"
        class="mu-input mu-select"
        :class="[`mu-input--${size}`, { 'is-disabled': disabled, 'mu-select--multiple': multiple, 'mu-select--readonly': !editable, [`is-${status}`]: status }]"
      >
        <template v-if="multiple">
          <span v-for="item in shownTags" :key="item" class="mu-select__tag">
            <span class="mu-select__tag-text"><slot name="tag" :value="item" :label="labelOf(item)">{{ labelOf(item) }}</slot></span>
            <button v-if="!disabled" type="button" class="mu-select__tag-x" tabindex="-1" :aria-label="text.close" @pointerdown.stop.prevent @click.stop="remove(item)">
              <span class="i-lucide-x" />
            </button>
          </span>
          <span v-if="selected.length > shownTags.length" class="mu-select__tag mu-select__tag--more">+{{ selected.length - shownTags.length }}</span>
        </template>
        <ComboboxInput
          class="mu-input__field mu-select__input"
          :placeholder="selected.length ? '' : placeholder"
          :readonly="!editable"
          :display-value="() => (multiple ? '' : labelOf(selected[0]))"
          @input="onInput"
          @keydown="onKeydown"
          @focus="onFocus"
          @blur="$emit('blur')"
        />
        <span v-if="loading" class="i-lucide-loader-circle mu-spin mu-select__arrow" />
        <button v-else-if="showClear" type="button" class="mu-input__clear mu-select__clear" tabindex="-1" :aria-label="text.clear" @pointerdown.stop.prevent @click.stop="clear">
          <span class="i-lucide-circle-x" />
        </button>
        <ComboboxTrigger class="mu-select__arrow" tabindex="-1">
          <span class="i-lucide-chevron-down" />
        </ComboboxTrigger>
      </ComboboxAnchor>

      <ComboboxPortal>
        <ComboboxContent position="popper" :side-offset="4" :collision-padding="8" class="mu-pop mu-select__menu">
          <ComboboxViewport class="mu-select__viewport">
            <ComboboxItem v-if="custom" :value="custom" class="mu-menu__item mu-select__item mu-select__item--custom">
              <span class="i-lucide-corner-down-left mu-select__custom-icon" />
              <span class="mu-select__label">{{ text.useValue.replace('{value}', custom) }}</span>
            </ComboboxItem>
            <template v-for="item in visible" :key="isGroup(item) ? `g:${item.key}` : `o:${item.value}`">
              <ComboboxGroup v-if="isGroup(item)">
                <ComboboxLabel class="mu-menu__label">{{ item.label }}</ComboboxLabel>
                <ComboboxItem v-for="option in item.children" :key="option.value" :value="option.value" :disabled="option.disabled" class="mu-menu__item mu-select__item">
                  <span class="mu-select__label"><slot name="option" :option="option">{{ option.label }}</slot><small v-if="option.description">{{ option.description }}</small></span>
                  <ComboboxItemIndicator class="mu-select__check"><span class="i-lucide-check" /></ComboboxItemIndicator>
                </ComboboxItem>
              </ComboboxGroup>
              <ComboboxItem v-else :value="item.value" :disabled="item.disabled" class="mu-menu__item mu-select__item">
                <span class="mu-select__label"><slot name="option" :option="item">{{ item.label }}</slot><small v-if="item.description">{{ item.description }}</small></span>
                <ComboboxItemIndicator class="mu-select__check"><span class="i-lucide-check" /></ComboboxItemIndicator>
              </ComboboxItem>
            </template>
            <div v-if="empty" class="mu-select__empty">{{ text.noOptions }}</div>
          </ComboboxViewport>
        </ComboboxContent>
      </ComboboxPortal>
    </ComboboxRoot>
  </div>
</template>

<style>
.mu-select-root { display: inline-flex; width: 100%; min-width: 0; vertical-align: middle; }
.mu-select-state { display: contents; }
.mu-select { padding-right: 4px; cursor: text; }
.mu-select--readonly,
.mu-select--readonly .mu-select__input { cursor: pointer; }
.mu-select--multiple { flex-wrap: wrap; gap: 4px; padding-top: 3px; padding-bottom: 3px; padding-left: 4px; }
.mu-select--multiple .mu-select__input { min-width: 40px; height: calc(var(--h) - 8px); padding-left: 4px; }
.mu-select__input::placeholder { color: var(--fg3); }
.mu-select__input:placeholder-shown { text-overflow: ellipsis; }

.mu-select__tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  height: calc(var(--h) - 10px);
  min-height: 18px;
  padding: 0 4px 0 7px;
  border-radius: 4px;
  background: var(--s1);
  color: var(--fg);
  font-size: 12.5px;
  box-shadow: inset 0 0 0 1px var(--line);
}

.mu-select__tag--more { padding: 0 7px; color: var(--fg2); }
.mu-select__tag-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.mu-select__tag-x {
  display: inline-flex;
  padding: 1px;
  border: 0;
  border-radius: 3px;
  background: none;
  color: var(--fg3);
  font-size: 12px;
  cursor: pointer;
}

.mu-select__tag-x:hover { color: var(--fg); background: var(--s3); }

.mu-select__arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: auto;
  padding: 0;
  border: 0;
  background: none;
  color: var(--fg3);
  font-size: 14px;
  cursor: pointer;
}

.mu-select__clear + .mu-select__arrow { margin-left: 0; }
.mu-select__clear { margin-left: auto; }
.mu-select[data-state='open'] .mu-select__arrow,
.mu-select-root[data-state='open'] .mu-select__arrow { color: var(--fg2); }

.mu-select__menu {
  width: var(--reka-combobox-trigger-width);
  min-width: 160px;
  padding: 4px;
}

.mu-select__viewport { max-height: min(320px, var(--reka-combobox-content-available-height, 320px)); overflow-y: auto; }
.mu-select__item { justify-content: space-between; }
.mu-select__item--custom { justify-content: flex-start; }
.mu-select__item[data-state='checked'] { color: var(--primary); font-weight: 500; }
.mu-select__label { display: flex; align-items: baseline; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mu-select__label small { color: var(--fg3); font-size: 12px; font-weight: 400; overflow: hidden; text-overflow: ellipsis; }
.mu-select__check { display: inline-flex; color: var(--primary); }
.mu-select__custom-icon { color: var(--fg3); }
.mu-select__empty { padding: 10px; color: var(--fg3); font-size: 13px; text-align: center; }
</style>
