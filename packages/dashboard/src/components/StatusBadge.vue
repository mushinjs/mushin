<script setup lang="ts">
import { Tag, Tooltip } from '@mushin/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ status: string; error?: string }>()
const { t, te } = useI18n()

const type = computed(() => {
  switch (props.status) {
    case 'online':
    case 'active':
      return 'success'
    case 'connecting':
    case 'pending':
    case 'loading':
    case 'unloading':
    case 'missing':
      return 'warning'
    case 'error':
    case 'failed':
      return 'error'
    default:
      return 'default'
  }
})

const label = computed(() => (te(`status.${props.status}`) ? t(`status.${props.status}`) : props.status))
</script>

<template>
  <Tooltip v-if="error" :max-width="320">
    <template #trigger>
      <Tag :type="type" size="small" round>{{ label }}</Tag>
    </template>
    {{ error }}
  </Tooltip>
  <Tag v-else :type="type" size="small" round>{{ label }}</Tag>
</template>
