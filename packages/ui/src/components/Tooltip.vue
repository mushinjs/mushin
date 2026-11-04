<script setup lang="ts">
/**
 * A hint on hover or focus. The #trigger slot is what it points at and the default slot (or
 * `content`) is the hint, so `<Tooltip><template #trigger>…</template>Hint</Tooltip>` reads like
 * the Naive UI tooltip it replaces.
 */
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui'

// Classes and styles go to the hint bubble.
defineOptions({ inheritAttrs: false })

withDefaults(defineProps<{
  content?: string
  placement?: 'top' | 'bottom' | 'left' | 'right'
  disabled?: boolean
  delay?: number
  maxWidth?: number
  showArrow?: boolean
}>(), { placement: 'top', delay: 300, maxWidth: 300, showArrow: true })
</script>

<template>
  <slot v-if="disabled || (!content && !$slots.default)" name="trigger" />
  <TooltipProvider v-else :delay-duration="delay">
    <TooltipRoot>
      <TooltipTrigger as-child>
        <slot name="trigger" />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent v-bind="$attrs" class="mu-tooltip" :side="placement" :side-offset="6" :collision-padding="8" :style="{ maxWidth: `${maxWidth}px` }">
          <slot>{{ content }}</slot>
          <TooltipArrow v-if="showArrow" class="mu-tooltip__arrow" :width="10" :height="5" />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>

<style>
.mu-tooltip {
  z-index: 3000;
  box-sizing: border-box;
  padding: 6px 10px;
  border-radius: 6px;
  background: #23252F;
  color: #F1F2F6;
  font-size: 12.5px;
  line-height: 1.5;
  box-shadow: var(--shadow-pop);
  white-space: pre-line;
  overflow-wrap: anywhere;
  animation: mu-fade-in 0.12s ease-out;
}

html[data-theme='dark'] .mu-tooltip { background: #3A3E4F; }
.mu-tooltip__arrow { fill: #23252F; }
html[data-theme='dark'] .mu-tooltip__arrow { fill: #3A3E4F; }

@keyframes mu-fade-in {
  from { opacity: 0; transform: scale(0.97); }
}
</style>
