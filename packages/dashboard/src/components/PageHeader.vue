<script setup lang="ts">
/**
 * The header every page starts with: the title, a one-line lead under it, and the page's actions on
 * the right. The actions never wrap under the title; on a phone the header stacks instead.
 */
defineProps<{ title: string; lead?: string }>()
</script>

<template>
  <header class="page-header">
    <div class="page-titles">
      <slot name="before" />
      <div class="page-text">
        <h1><slot name="title">{{ title }}</slot></h1>
        <p v-if="lead || $slots.lead" class="page-lead" :title="lead"><slot name="lead">{{ lead }}</slot></p>
      </div>
    </div>
    <div v-if="$slots.default" class="page-actions">
      <slot />
    </div>
  </header>
</template>

<style scoped>
.page-titles {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.page-text {
  min-width: 0;
}
</style>
