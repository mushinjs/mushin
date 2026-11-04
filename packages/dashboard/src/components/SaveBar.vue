<script setup lang="ts">
/**
 * Stays at the bottom of the window while there are unsaved changes, so saving never needs a
 * scroll: what is unsaved, a way to undo it, and the save button.
 */
import { Button } from '@mushin/ui'

defineProps<{ show: boolean; saving?: boolean; text: string; discardText: string; saveText: string }>()
defineEmits<{ discard: []; save: [] }>()
</script>

<template>
  <Transition name="savebar">
    <div v-if="show || saving" class="savebar" role="region" :aria-label="text">
      <span class="savebar-text"><span class="savebar-dot" />{{ text }}</span>
      <Button quaternary class="savebar-undo" :disabled="saving" @click="$emit('discard')">{{ discardText }}</Button>
      <Button type="primary" :loading="saving" @click="$emit('save')">{{ saveText }}</Button>
    </div>
  </Transition>
</template>

<style scoped>
.savebar {
  position: sticky;
  bottom: 16px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding: 10px 12px 10px 18px;
  border-radius: var(--radius);
  background: #1B1D29;
  color: #E8E9F0;
  box-shadow: 0 8px 24px rgba(10, 12, 30, 0.28);
}

html[data-theme='dark'] .savebar {
  background: #2A2D3A;
}

.savebar-text {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.savebar-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--warn);
}

.savebar-undo {
  color: inherit;
}

.savebar-enter-active,
.savebar-leave-active {
  transition: transform 0.24s ease, opacity 0.24s ease;
}

.savebar-enter-from,
.savebar-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

@media (prefers-reduced-motion: reduce) {
  .savebar-enter-active,
  .savebar-leave-active {
    transition: none;
  }
}
</style>
