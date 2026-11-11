<script setup lang="ts">
import { Button, Tooltip } from '@mushinjs/ui'

/**
 * A row action shown as an icon, with its name as tooltip and accessible label. `icon` is an icon
 * class, such as `i-lucide-trash-2`.
 */
defineProps<{
  icon: string
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
        :icon="icon"
      />
    </template>
    {{ label }}
  </Tooltip>
</template>

<style scoped>
.icon-action :deep(.mu-btn__icon) {
  font-size: 16px;
}
</style>
