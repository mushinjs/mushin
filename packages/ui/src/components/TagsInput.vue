<script setup lang="ts">
/** A list of short texts: type and press Enter (or a comma) to add one, Backspace to remove the last. */
import { TagsInputInput, TagsInputItem, TagsInputItemDelete, TagsInputItemText, TagsInputRoot } from 'reka-ui'
import { type Size, useText } from '../config'

withDefaults(defineProps<{
  value?: string[] | null
  placeholder?: string
  size?: Size
  disabled?: boolean
  max?: number
}>(), { size: 'medium' })

const emit = defineEmits<{ 'update:value': [value: string[]] }>()
const text = useText()
</script>

<template>
  <TagsInputRoot
    class="mu-input mu-tags"
    :class="[`mu-input--${size}`, { 'is-disabled': disabled }]"
    :model-value="value ?? []"
    :disabled="disabled"
    :max="max"
    add-on-paste
    add-on-blur
    :delimiter="/[,，]/"
    @update:model-value="(next) => emit('update:value', next.map(String))"
  >
    <TagsInputItem v-for="item in value ?? []" :key="item" :value="item" class="mu-select__tag">
      <TagsInputItemText class="mu-select__tag-text" />
      <TagsInputItemDelete class="mu-select__tag-x" :aria-label="text.close"><span class="i-lucide-x" /></TagsInputItemDelete>
    </TagsInputItem>
    <TagsInputInput class="mu-input__field mu-tags__input" :placeholder="value?.length ? '' : placeholder ?? text.add" />
  </TagsInputRoot>
</template>

<style>
.mu-tags { flex-wrap: wrap; gap: 4px; padding: 3px 4px; cursor: text; }
.mu-tags__input { min-width: 60px; height: calc(var(--h) - 8px); padding-left: 4px; }
.mu-tags .mu-select__tag[data-state='active'] { box-shadow: inset 0 0 0 1px var(--primary); }
</style>
