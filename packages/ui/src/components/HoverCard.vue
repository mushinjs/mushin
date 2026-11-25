<script setup lang="ts">
/**
 * A floating panel that opens while the pointer rests on its #trigger (or it has keyboard focus), for a
 * look at something without clicking; the default slot is the panel. `disabled` leaves the trigger alone.
 */
import { HoverCardContent, HoverCardPortal, HoverCardRoot, HoverCardTrigger } from 'reka-ui'

defineOptions({ inheritAttrs: false })

withDefaults(defineProps<{
  placement?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  width?: number
  padded?: boolean
  disabled?: boolean
  /** Milliseconds the pointer rests before the panel opens. */
  delay?: number
}>(), { placement: 'bottom', align: 'center', padded: true, delay: 250 })
</script>

<template>
  <slot v-if="disabled" name="trigger" />
  <HoverCardRoot v-else :open-delay="delay" :close-delay="150">
    <HoverCardTrigger as-child>
      <slot name="trigger" />
    </HoverCardTrigger>
    <HoverCardPortal>
      <HoverCardContent
        v-bind="$attrs"
        class="mu-pop"
        :class="{ 'mu-pop--padded': padded }"
        :side="placement"
        :align="align"
        :side-offset="6"
        :collision-padding="8"
        :style="width ? { width: `${width}px` } : undefined"
      >
        <slot />
      </HoverCardContent>
    </HoverCardPortal>
  </HoverCardRoot>
</template>
