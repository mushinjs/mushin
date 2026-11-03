<script setup lang="ts">
import { NButton, NDropdown, NInput } from 'naive-ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { wholeRef } from '../../flow'

export interface VarGroup {
  key: string
  label: string
  items: { ref: string; label: string; type: string }[]
}

const props = defineProps<{ groups: VarGroup[]; placeholder?: string; multiline?: boolean }>()
const value = defineModel<string>({ default: '' })
const { t } = useI18n()

const options = computed(() => props.groups.map((group) => ({
  type: 'group' as const,
  key: group.key,
  label: group.label,
  children: group.items.map((item) => ({ key: item.ref, label: `${item.label} · ${item.type}` })),
})))

/** An empty input or a lone reference is replaced; other text gets the reference appended. */
function insert(ref: string) {
  const current = value.value ?? ''
  value.value = !current.trim() || (!props.multiline && wholeRef(current)) ? ref : `${current}${ref}`
}
</script>

<template>
  <div v-if="multiline" class="multi">
    <NInput v-model:value="value" size="small" type="textarea" :autosize="{ minRows: 2, maxRows: 10 }" :placeholder="placeholder ?? t('flows.varsPlaceholder')" />
    <NDropdown trigger="click" :options="options" scrollable size="small" placement="bottom-end" style="max-height: 320px" @select="insert">
      <NButton text size="tiny" class="var-button corner" :title="t('flows.varsInsert')">(x)</NButton>
    </NDropdown>
  </div>
  <NInput v-else v-model:value="value" size="small" clearable :placeholder="placeholder ?? t('flows.varsPlaceholder')">
    <template #suffix>
      <NDropdown trigger="click" :options="options" scrollable size="small" placement="bottom-end" style="max-height: 320px" @select="insert">
        <NButton text size="tiny" class="var-button" :title="t('flows.varsInsert')">(x)</NButton>
      </NDropdown>
    </template>
  </NInput>
</template>

<style scoped>
.multi {
  position: relative;
}

.corner {
  position: absolute;
  top: 4px;
  right: 8px;
}

.var-button {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  color: var(--primary);
}
</style>
