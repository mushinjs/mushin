<script setup lang="ts">
/**
 * What a page shows before it has anything: an icon for the kind of thing, one line on what it is
 * for, and the ways to make the first one.
 */
/** `icon` is an icon class, such as `i-lucide-bot`. */
defineProps<{ icon: string; title: string; hint?: string }>()
</script>

<template>
  <div class="empty-state">
    <span class="empty-icon"><span :class="icon" /></span>
    <strong class="empty-title">{{ title }}</strong>
    <p v-if="hint" class="empty-hint">{{ hint }}</p>
    <div v-if="$slots.default" class="empty-actions"><slot /></div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 48px 24px;
  border: 1.5px dashed var(--line);
  border-radius: var(--radius);
  text-align: center;
}

.empty-icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  margin-bottom: 6px;
  border-radius: 50%;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 24px;
}

.empty-title {
  font-size: 15px;
  font-weight: 600;
}

.empty-hint {
  max-width: 440px;
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--fg2);
}

.empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 12px;
}
</style>
