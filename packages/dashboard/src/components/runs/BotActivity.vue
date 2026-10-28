<script setup lang="ts">
import { computed } from 'vue'
import { useRunsStore } from '../../stores/runs'
import { runColors, useRunText } from './useRunText'

const props = defineProps<{ botId: string }>()
const store = useRunsStore()
const { activityText } = useRunText()

const activity = computed(() => store.activityOf(props.botId))
const color = computed(() => (activity.value.run ? runColors[activity.value.run.status] : '#8c8c8c'))
</script>

<template>
  <span class="activity" :class="{ busy: !!activity.run }" :style="{ '--dot': color }" :title="activityText(activity)">
    <span class="dot" />
    <span class="text">{{ activityText(activity) }}</span>
  </span>
</template>

<style scoped>
.activity {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
}

.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dot);
  opacity: 0.7;
}

.busy .dot {
  opacity: 1;
  animation: pulse 1.4s ease-in-out infinite;
}

.text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.75;
}

.busy .text {
  opacity: 1;
}

@keyframes pulse {
  50% {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--dot) 25%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .busy .dot {
    animation: none;
  }
}
</style>
