<script setup lang="ts">
import { Button, Tooltip } from '@mushin/ui'
import type { Component } from 'vue'

/**
 * A row action shown as an icon, with its name as tooltip and accessible label. `icon` is an icon
 * class (`i-lucide-trash-2`); a component still works for pages not yet moved over.
 */
defineProps<{
  icon: string | Component
  label: string
  type?: 'default' | 'primary' | 'error' | 'warning'
  disabled?: boolean
  loading?: boolean
}>()
const emit = defineEmits<{ click: [event: MouseEvent] }>()
</script>

<template>
  <Tooltip :delay="300">
    <template #trigger>
      <Button
        quaternary
        circle
        size="small"
        class="icon-action"
        :type="type ?? 'default'"
        :disabled="disabled"
        :loading="loading"
        :aria-label="label"
        @click.stop="(event: MouseEvent) => emit('click', event)"
        :icon="typeof icon === 'string' ? icon : undefined"
      >
        <template v-if="typeof icon !== 'string'" #icon><component :is="icon" /></template>
      </Button>
    </template>
    {{ label }}
  </Tooltip>
</template>

<style scoped>
.icon-action :deep(.mu-btn__icon) {
  font-size: 16px;
}
</style>
