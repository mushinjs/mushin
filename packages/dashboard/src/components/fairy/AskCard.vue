<script setup lang="ts">
import { Input, Tag } from '@mushinjs/ui'
import { useI18n } from 'vue-i18n'
import type { AskItem } from '../../stores/fairy'

/** A question Fairy waits on: its options to pick, and a box for another answer when it allows one. */
defineProps<{ ask: AskItem }>()
const emit = defineEmits<{ answer: [result: { choice: number } | { other: string }] }>()

const { t } = useI18n()

function other(event: KeyboardEvent) {
  const value = (event.target as HTMLInputElement).value.trim()
  if (value) emit('answer', { other: value })
}
</script>

<template>
  <div class="ask">
    <div class="ask-question"><span class="i-lucide-circle-help" />{{ ask.question }}</div>
    <button
      v-for="(option, index) in ask.options"
      :key="index"
      type="button"
      class="ask-option"
      :class="{ recommended: ask.recommended === index }"
      @click="emit('answer', { choice: index })"
    >
      <span class="ask-label">
        {{ option.label }}
        <Tag v-if="ask.recommended === index" size="tiny" type="success">{{ t('fairyPalette.recommended') }}</Tag>
      </span>
      <span v-if="option.description" class="ask-desc">{{ option.description }}</span>
    </button>
    <Input v-if="ask.allowOther" size="small" :placeholder="t('fairyMessage.other')" @keydown.enter="other" />
  </div>
</template>

<style scoped>
.ask {
  border: 1px solid var(--warn);
  border-radius: 10px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--warn-soft);
  font-size: 13px;
}

/* The chat's size and weight, so a long question reads like a message rather than a heading. */
.ask-question {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin-bottom: 2px;
  font-size: 14px;
  line-height: 1.6;
}

.ask-question span {
  flex: none;
  margin-top: 4px;
  color: var(--warn);
}

.ask-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  font: inherit;
  font-size: 13px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--s1);
  color: inherit;
  cursor: pointer;
}

.ask-option:hover,
.ask-option.recommended {
  border-color: var(--primary);
}

.ask-label {
  display: flex;
  gap: 6px;
  align-items: center;
}

.ask-desc {
  font-size: 12px;
  opacity: 0.65;
}
</style>
