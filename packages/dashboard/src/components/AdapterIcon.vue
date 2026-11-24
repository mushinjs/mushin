<script setup lang="ts">
import { computed } from 'vue'
import type { AdapterType } from '../types'

/**
 * A platform's logo from its adapter, in the adapter's colour (or `tint`). The SVG is drawn as a CSS
 * mask, so whatever an adapter puts in it never runs as markup. Adapters without one get a plug.
 */
const props = defineProps<{ adapter: AdapterType | undefined; size?: number; tint?: string }>()

const style = computed(() => {
  const size = `${props.size ?? 20}px`
  const icon = props.adapter?.icon
  if (!icon) return { width: size, height: size, fontSize: size, color: props.tint ?? props.adapter?.color }
  const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${icon}</svg>`)}")`
  return {
    width: size,
    height: size,
    background: props.tint ?? props.adapter?.color ?? 'currentColor',
    mask: `${url} center / contain no-repeat`,
    WebkitMask: `${url} center / contain no-repeat`,
  }
})
</script>

<template>
  <span class="adapter-icon" :class="{ 'i-lucide-plug': !adapter?.icon }" :style="style" aria-hidden="true" />
</template>

<style scoped>
.adapter-icon {
  display: inline-block;
  flex: none;
}
</style>
