<script setup lang="ts">
import { computed } from 'vue'
import { renderSVG } from 'uqr'

const props = withDefaults(defineProps<{ text: string; size?: number }>(), { size: 180 })

// Dark modules on a white card, so phones read it in the dark theme too.
const svg = computed(() => renderSVG(props.text, { border: 2, blackColor: '#000', whiteColor: '#fff' }))
</script>

<template>
  <div class="qr" :style="{ width: `${size}px`, height: `${size}px` }" role="img" :aria-label="text" v-html="svg" />
</template>

<style scoped>
.qr {
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
  flex: none;
}

.qr :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
