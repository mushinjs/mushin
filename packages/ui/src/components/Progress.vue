<script setup lang="ts">
/** A line that fills to `percentage`. The default slot is a short label drawn beside it. */
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  percentage?: number
  /** Animates the filled part while work is still going. */
  processing?: boolean
  status?: 'default' | 'success' | 'warning' | 'error'
}>(), { percentage: 0, status: 'default' })

const width = computed(() => `${Math.min(100, Math.max(0, props.percentage))}%`)
</script>

<template>
  <div class="mu-progress" :class="[`mu-progress--${status}`, { 'is-processing': processing }]" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(percentage)">
    <div class="mu-progress__track"><div class="mu-progress__fill" :style="{ width }" /></div>
    <span v-if="$slots.default" class="mu-progress__label"><slot /></span>
  </div>
</template>

<style>
.mu-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.mu-progress__track {
  flex: 1;
  min-width: 40px;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--s3);
}

.mu-progress__fill {
  position: relative;
  height: 100%;
  overflow: hidden;
  border-radius: inherit;
  background: var(--primary);
  transition: width 0.25s ease;
}

.mu-progress--success .mu-progress__fill { background: var(--ok); }
.mu-progress--warning .mu-progress__fill { background: var(--warn); }
.mu-progress--error .mu-progress__fill { background: var(--bad); }

.mu-progress.is-processing .mu-progress__fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.35), transparent);
  animation: mu-progress-sweep 1.4s ease-in-out infinite;
}

.mu-progress__label {
  flex: none;
  color: var(--fg2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

@keyframes mu-progress-sweep {
  from { transform: translateX(-100%); }
  to { transform: translateX(100%); }
}

@media (prefers-reduced-motion: reduce) {
  .mu-progress.is-processing .mu-progress__fill::after { animation: none; }
}
</style>
