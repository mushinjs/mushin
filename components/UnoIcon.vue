<script setup lang="ts">
withDefaults(defineProps<{
  icon?: string
  title?: string
  showTitle?: boolean
}>(), {
  showTitle: true,
})
</script>

<template>
  <div
    :style="{ width: '1em', height: '1em' }"
    v-bind="$attrs"
    :class="icon || 'logos-nuxt-icon'"
    :title="showTitle ? title : undefined"
  />
</template>
