<script setup lang="ts">
/** A window with its left or right column filled while that panel is open. */
defineProps<{ side: 'left' | 'right' | 'bottom', open: boolean }>()
</script>

<template>
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.25" />
    <template v-if="side === 'bottom'">
      <path d="M3 11.5h14" />
      <rect v-if="open" x="3.5" y="11.5" width="13" height="4" rx="1" fill="currentColor" stroke="none" opacity="0.55" />
    </template>
    <template v-else>
      <path :d="side === 'left' ? 'M7.5 4v12' : 'M12.5 4v12'" />
      <rect v-if="open" :x="side === 'left' ? 3.5 : 12.5" y="4.5" width="4" height="11" rx="1" fill="currentColor" stroke="none" opacity="0.55" />
    </template>
  </svg>
</template>
