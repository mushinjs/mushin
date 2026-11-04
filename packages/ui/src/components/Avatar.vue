<script setup lang="ts">
/** A round picture, or its initials on a colour when there is no picture (or it fails to load). */
import { ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  src?: string
  size?: number
  /** Background behind the initials. */
  color?: string
  /** Rounded square instead of a circle. */
  square?: boolean
}>(), { size: 32 })

const failed = ref(false)
watch(() => props.src, () => (failed.value = false))
</script>

<template>
  <span
    class="mu-avatar"
    :class="{ 'mu-avatar--square': square }"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, background: src && !failed ? undefined : color }"
  >
    <img v-if="src && !failed" :src="src" alt="" @error="failed = true">
    <slot v-else />
  </span>
</template>

<style>
.mu-avatar {
  display: inline-grid;
  flex: none;
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  background: var(--s3);
  color: #fff;
  font-weight: 600;
  line-height: 1;
  user-select: none;
}

.mu-avatar--square { border-radius: 25%; }
.mu-avatar img { width: 100%; height: 100%; object-fit: cover; }
</style>
