<script setup lang="ts">
import { highlightState } from '../highlight'
</script>

<template>
  <Transition name="fade">
    <div
      v-if="highlightState.visible"
      class="agent-tip"
      :style="{ top: `${highlightState.top}px`, left: `${highlightState.left}px` }"
      role="status"
    >
      {{ highlightState.message }}
    </div>
  </Transition>
</template>

<style scoped>
.agent-tip {
  position: fixed;
  z-index: 3000;
  max-width: 280px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
  background: var(--primary);
  color: var(--primary-fg);
  pointer-events: none;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
