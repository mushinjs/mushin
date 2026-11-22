<script setup lang="ts">
import { Tag, Tooltip } from '@mushinjs/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/** A status as a tag, or with `dot` as a colored dot that names the status on hover, for narrow lists. */
const props = defineProps<{ status: string; error?: string; dot?: boolean }>()
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
  <Tooltip v-if="dot" :max-width="320">
    <template #trigger>
      <span class="status-dot" :class="type" role="img" :aria-label="error ? `${label}: ${error}` : label" />
    </template>
    {{ label }}<template v-if="error">: {{ error }}</template>
  </Tooltip>
  <Tooltip v-else-if="error" :max-width="320">
    <template #trigger>
      <Tag :type="type" size="small" round>{{ label }}</Tag>
    </template>
    {{ error }}
  </Tooltip>
  <Tag v-else :type="type" size="small" round>{{ label }}</Tag>
</template>

<style scoped>
.status-dot {
  flex: none;
  display: inline-block;
  width: 8px;
  height: 8px;
  margin: 0 5px;
  border-radius: 50%;
  background: var(--fg3);
}

.status-dot.success {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-soft);
}

.status-dot.warning {
  background: var(--warn);
  box-shadow: 0 0 0 3px var(--warn-soft);
}

.status-dot.error {
  background: var(--bad);
  box-shadow: 0 0 0 3px var(--bad-soft);
}
</style>
