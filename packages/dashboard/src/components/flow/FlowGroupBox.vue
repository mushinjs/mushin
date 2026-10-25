<script setup lang="ts">
import { AlbumsOutline, ExpandOutline } from '@vicons/ionicons5'
import { Handle, Position } from '@vue-flow/core'
import { NIcon, NSpin } from 'naive-ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { type CanvasNodeData, type RunStatus, useFlowEditor } from './context'

/**
 * A collapsed group: one box in place of its nodes. Connections into and out of the group are
 * drawn to its two handles; they cannot be edited here, so the handles do not connect.
 */
const props = defineProps<{ id: string; data: CanvasNodeData; selected: boolean }>()
const { t } = useI18n()
const editor = useFlowEditor()

const group = computed(() => editor.groups.value.find((item) => item.id === props.data.groupId))
/** The most telling state among the group's nodes during or after a run. */
const run = computed<RunStatus | undefined>(() => {
  const states = (group.value?.nodes ?? []).map((id) => editor.highlight.value.nodes.get(id))
  return (['running', 'error', 'ok', 'skipped'] as const).find((state) => states.includes(state))
})
</script>

<template>
  <div class="group-box" :class="{ selected, [`run-${run}`]: !!run }" :title="t('flows.groupBoxHint')">
    <Handle id="exec" type="target" :position="Position.Left" :connectable="false" class="handle" />
    <span class="icon"><NIcon :size="16"><AlbumsOutline /></NIcon></span>
    <div class="text">
      <div class="name">{{ group?.label || t('flows.groupDefault') }}</div>
      <div class="count">{{ t('flows.groupCount', group?.nodes.length ?? 0) }}</div>
    </div>
    <NSpin v-if="run === 'running'" :size="12" />
    <button type="button" class="expand nodrag" :title="t('flows.menuExpand')" @click.stop="group && editor.toggleGroup(group.id)">
      <NIcon :size="14"><ExpandOutline /></NIcon>
    </button>
    <Handle id="out" type="source" :position="Position.Right" :connectable="false" class="handle" />
  </div>
</template>

<style scoped>
.group-box {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 220px;
  padding: 10px 10px 10px 12px;
  box-sizing: border-box;
  border-radius: 12px;
  border: 1.5px dashed rgba(127, 127, 127, 0.6);
  background: var(--flow-node-bg, #fff);
  color: var(--flow-node-fg, #222);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
  font-size: 12px;
}

.group-box.selected {
  border-color: #2080f0;
}

.group-box.run-running {
  border-color: #2080f0;
  border-style: solid;
}

.group-box.run-ok {
  border-color: #18a058;
}

.group-box.run-error {
  border-color: #d03050;
}

.icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.16);
}

.text {
  flex: 1;
  min-width: 0;
}

.name {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  opacity: 0.6;
}

.expand {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.7;
}

.expand:hover {
  background: rgba(127, 127, 127, 0.14);
  opacity: 1;
}

.handle {
  width: 9px;
  height: 9px;
  background: #8c8c8c;
  border: none;
}
</style>
