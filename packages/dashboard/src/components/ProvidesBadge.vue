<script setup lang="ts">
import { Tooltip } from '@mushinjs/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PluginProvides } from '../types'

/**
 * What a running plugin adds, as small counts with icons (commands, flow nodes, tools, adapters). Hovering lists the
 * names. Shows nothing for a plugin that adds none of them, or does not run.
 */
const props = defineProps<{ value?: PluginProvides }>()
const { t } = useI18n()

const KINDS = [
  { key: 'commands', icon: 'i-lucide-square-slash' },
  { key: 'nodes', icon: 'i-lucide-workflow' },
  { key: 'tools', icon: 'i-lucide-wrench' },
  { key: 'adapters', icon: 'i-lucide-plug' },
] as const

/** Names shown per kind in the tooltip; the rest are counted. */
const LIMIT = 12

const parts = computed(() => KINDS.filter(({ key }) => props.value?.[key].length).map(({ key, icon }) => {
  const names = props.value![key]
  return { key, icon, count: names.length, names: key === 'commands' ? names.map((name) => `/${name}`) : names }
}))

const label = computed(() => parts.value.map((part) => t(`plugins.provides.${part.key}`, part.count)).join(t('plugins.provides.separator')))
</script>

<template>
  <Tooltip v-if="parts.length" :max-width="380">
    <template #trigger>
      <span class="provides" :aria-label="label">
        <span v-for="part in parts" :key="part.key" class="part">
          <span :class="part.icon" class="part-icon" />{{ part.count }}
        </span>
      </span>
    </template>
    <div class="tip">
      <div v-for="part in parts" :key="part.key" class="tip-part">
        <strong>{{ t(`plugins.provides.${part.key}`, part.count) }}</strong>
        <span class="mono names">
          {{ part.names.slice(0, LIMIT).join('  ') }}<template v-if="part.count > LIMIT">{{ t('plugins.provides.more', { n: part.count - LIMIT }) }}</template>
        </span>
      </div>
    </div>
  </Tooltip>
</template>

<style scoped>
.provides {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--s2);
  color: var(--fg2);
  font-size: 12px;
  white-space: nowrap;
}

.part {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.part-icon {
  font-size: 12px;
  color: var(--fg3);
}

.tip {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tip-part {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.names {
  font-size: 12px;
  word-break: break-word;
  white-space: pre-wrap;
  opacity: 0.85;
}
</style>
