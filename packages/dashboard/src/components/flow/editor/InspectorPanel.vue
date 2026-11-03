<script setup lang="ts">
/** The panel beside the canvas: the selected node's settings, or the flow's. */
import { NTabPane, NTabs } from 'naive-ui'
import { useEditor } from './editor'
import FlowPanel from './FlowPanel.vue'
import NodePanel from './NodePanel.vue'

const { t, tab } = useEditor()
</script>

<template>
  <aside class="panel side">
    <NTabs v-model:value="tab" type="line" size="small" justify-content="space-evenly" class="panel-tabs">
      <NTabPane name="node" :tab="t('flows.tabNode')">
        <NodePanel />
      </NTabPane>
      <NTabPane name="flow" :tab="t('flows.tabFlow')">
        <FlowPanel />
      </NTabPane>
    </NTabs>
  </aside>
</template>

<style scoped>
.panel {
  width: 340px;
  flex: none;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 4px 14px 0;
  border-left: 1px solid rgba(127, 127, 127, 0.18);
  background: var(--flow-node-bg);
}
</style>
