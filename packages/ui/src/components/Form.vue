<script setup lang="ts">
/** Lays out FormItem children: labels above (`top`) or beside (`left`) their fields. */
import { computed, provide } from 'vue'
import type { Size } from '../config'
import { FORM } from './form'

const props = withDefaults(defineProps<{
  labelPlacement?: 'top' | 'left'
  labelWidth?: number | string
  size?: Size
  /** Less space between fields, for side panels. */
  compact?: boolean
  /** Renders a <form> that emits `submit`; the default <div> can sit inside another form. */
  as?: 'div' | 'form'
}>(), { as: 'div', labelPlacement: 'top', size: 'medium' })

defineEmits<{ submit: [event: Event] }>()

provide(FORM, {
  labelPlacement: computed(() => props.labelPlacement),
  labelWidth: computed(() => props.labelWidth),
  size: computed(() => props.size),
})
</script>

<template>
  <component :is="as" class="mu-form" :class="{ 'mu-form--compact': compact }" @submit.prevent="$emit('submit', $event)">
    <slot />
  </component>
</template>

<style>
.mu-form { display: flex; flex-direction: column; gap: 18px; }
.mu-form--compact { gap: 14px; }
</style>
