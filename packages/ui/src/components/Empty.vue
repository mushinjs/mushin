<script setup lang="ts">
/** Shown where a list or panel has nothing in it yet. #extra holds an action. */
withDefaults(defineProps<{ description?: string; icon?: string; size?: 'small' | 'medium' }>(), { icon: 'i-lucide-inbox', size: 'medium' })
</script>

<template>
  <div class="mu-empty" :class="`mu-empty--${size}`">
    <span class="mu-empty__icon" :class="icon" />
    <p v-if="description || $slots.default" class="mu-empty__text"><slot>{{ description }}</slot></p>
    <div v-if="$slots.extra" class="mu-empty__extra"><slot name="extra" /></div>
  </div>
</template>

<style>
.mu-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 12px;
  color: var(--fg3);
  text-align: center;
}

.mu-empty__icon { font-size: 36px; opacity: 0.7; }
.mu-empty--small { padding: 12px; gap: 6px; }
.mu-empty--small .mu-empty__icon { font-size: 26px; }
.mu-empty__text { margin: 0; font-size: 13px; line-height: 1.5; }
.mu-empty__extra { margin-top: 4px; }
</style>
