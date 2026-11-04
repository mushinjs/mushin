<script setup lang="ts">
import { Button, Dropdown, Input } from '@mushin/ui'
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
    <Input v-model:value="value" size="small" type="textarea" :autosize="{ minRows: 2, maxRows: 10 }" :placeholder="placeholder ?? t('flows.varsPlaceholder')" />
    <Dropdown :options="options" placement="bottom" align="end" @select="insert">
      <Button text size="tiny" class="var-button corner" :title="t('flows.varsInsert')">(x)</Button>
    </Dropdown>
  </div>
  <Input v-else v-model:value="value" size="small" clearable :placeholder="placeholder ?? t('flows.varsPlaceholder')">
    <template #suffix>
      <Dropdown :options="options" placement="bottom" align="end" @select="insert">
        <Button text size="tiny" class="var-button" :title="t('flows.varsInsert')">(x)</Button>
      </Dropdown>
    </template>
  </Input>
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
