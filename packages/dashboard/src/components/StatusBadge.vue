<script setup lang="ts">
import { NTag, NTooltip } from 'naive-ui'
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
  <NTooltip v-if="error" :style="{ maxWidth: '320px' }">
    <template #trigger>
      <NTag :type="type" size="small" round :bordered="false">{{ label }}</NTag>
    </template>
    {{ error }}
  </NTooltip>
  <NTag v-else :type="type" size="small" round :bordered="false">{{ label }}</NTag>
</template>
