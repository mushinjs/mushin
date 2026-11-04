<script setup lang="ts">
import { Button, Spin, Tag } from '@mushin/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChatItem } from '../../stores/agent'
import { pretty } from '../../utils'

/** One tool call of an Agent reply: what it called, how it went, and its input and output on demand. */
const props = defineProps<{ item: Extract<ChatItem, { kind: 'tool' }>; expanded: boolean }>()
const emit = defineEmits<{ toggle: []; confirm: [approved: boolean] }>()

const { t } = useI18n()

/** The first line of a failure, shown under the row so nobody has to open it to see why. */
const reason = computed(() => {
  if (props.item.state !== 'error' || !props.item.error) return ''
  return props.item.error.replace(/^Error:\s*/, '').split('\n')[0]
})
</script>

<template>
  <div class="tool" :class="item.state">
    <button class="tool-row" type="button" @click="emit('toggle')">
      <Spin v-if="item.state === 'running'" :size="14" />
      <span v-else-if="item.state === 'ok'" class="i-lucide-circle-check" color="var(--ok)" />
      <span v-else-if="item.state === 'confirm'" class="i-lucide-hand" color="var(--warn)" />
      <span v-else class="i-lucide-circle-x" color="var(--bad)" />
      <span class="mono tool-name">{{ item.action }}</span>
      <Tag v-if="item.risk === 'dangerous'" size="tiny" type="error">{{ t('agent.dangerous') }}</Tag>
      <span class="tool-state">{{ t(`agent.state.${item.state}`) }}</span>
    </button>
    <div v-if="reason && !expanded" class="tool-reason" :title="reason">{{ reason }}</div>
    <div v-if="item.state === 'confirm'" class="confirm">
      <p>{{ t('agent.confirmText', { action: item.action }) }}</p>
      <pre class="json mono">{{ pretty(item.input) }}</pre>
      <div class="confirm-actions">
        <Button size="small" type="error" @click="emit('confirm', true)">{{ t('agent.approve') }}</Button>
        <Button size="small" @click="emit('confirm', false)">{{ t('agent.deny') }}</Button>
      </div>
    </div>
    <div v-else-if="expanded" class="tool-detail">
      <div class="label">{{ t('agent.input') }}</div>
      <pre class="json mono">{{ pretty(item.input) }}</pre>
      <template v-if="item.result !== undefined || item.error">
        <div class="label">{{ t('agent.output') }}</div>
        <pre class="json mono">{{ item.error ?? pretty(item.result) }}</pre>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tool {
  border: 1px solid rgba(127, 127, 127, 0.2);
  border-radius: 8px;
  font-size: 13px;
}

.tool.confirm {
  border-color: var(--warn);
}

.tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.tool-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-state {
  opacity: 0.6;
  font-size: 12px;
}

.tool-reason {
  margin: -2px 10px 7px 32px;
  font-size: 12px;
  color: var(--bad);
  opacity: 0.85;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tool-detail,
.confirm {
  padding: 0 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.confirm p {
  margin: 0;
}

.confirm-actions {
  display: flex;
  gap: 8px;
}

.label {
  font-size: 12px;
  opacity: 0.6;
}
</style>
