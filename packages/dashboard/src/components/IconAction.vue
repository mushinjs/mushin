<script setup lang="ts">
import { NButton, NIcon, NTooltip } from 'naive-ui'
import type { Component } from 'vue'

/** A row action shown as an icon, with its name as tooltip and accessible label. */
defineProps<{
  icon: Component
  label: string
  type?: 'default' | 'primary' | 'error' | 'warning'
  disabled?: boolean
  loading?: boolean
}>()
const emit = defineEmits<{ click: [event: MouseEvent] }>()
</script>

<template>
  <NTooltip :delay="300">
    <template #trigger>
      <NButton
        quaternary
        circle
        size="small"
        class="icon-action"
        :type="type ?? 'default'"
        :disabled="disabled"
        :loading="loading"
        :aria-label="label"
        @click.stop="(event: MouseEvent) => emit('click', event)"
      >
        <template #icon><NIcon><component :is="icon" /></NIcon></template>
      </NButton>
    </template>
    {{ label }}
  </NTooltip>
</template>
