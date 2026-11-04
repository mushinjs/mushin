<script setup lang="ts">
/** A surface with an optional title row (#header-extra on its right) and footer. */
defineProps<{
  title?: string
  size?: 'small' | 'medium'
  /** Lifts on hover and shows a pointer, for cards that open something. */
  hoverable?: boolean
  /** A sunken card inside another surface. */
  embedded?: boolean
}>()
</script>

<template>
  <section class="mu-card" :class="[`mu-card--${size ?? 'medium'}`, { 'mu-card--hoverable': hoverable, 'mu-card--embedded': embedded }]">
    <header v-if="title || $slots.header || $slots['header-extra']" class="mu-card__header">
      <div class="mu-card__title"><slot name="header">{{ title }}</slot></div>
      <div v-if="$slots['header-extra']" class="mu-card__extra"><slot name="header-extra" /></div>
    </header>
    <div class="mu-card__body"><slot /></div>
    <footer v-if="$slots.footer" class="mu-card__footer"><slot name="footer" /></footer>
  </section>
</template>

<style>
.mu-card {
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
  color: var(--fg);
}

.mu-card--embedded { border-color: transparent; background: var(--s2); }
.mu-card--hoverable { cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s; }
.mu-card--hoverable:hover { border-color: var(--line-strong); box-shadow: var(--shadow); }

.mu-card__header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px 0;
}

.mu-card__title { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; }
.mu-card__extra { display: flex; align-items: center; gap: 8px; }
.mu-card__body { padding: 16px 20px 20px; }
.mu-card__footer { padding: 0 20px 16px; }
.mu-card--small .mu-card__header { padding: 12px 14px 0; }
.mu-card--small .mu-card__title { font-size: 14px; }
.mu-card--small .mu-card__body { padding: 12px 14px 14px; }
.mu-card--small .mu-card__footer { padding: 0 14px 12px; }
</style>
