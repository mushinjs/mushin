<script setup lang="ts">
/** The panel beside the canvas: the selected node's settings, or the flow's. */
import { TabPane, Tabs } from '@mushin/ui'
import { useEditor } from './editor'
import FlowPanel from './FlowPanel.vue'
import NodePanel from './NodePanel.vue'

const { t, tab } = useEditor()
</script>

<template>
  <aside class="panel side">
    <Tabs v-model:value="tab" type="line" size="small" justify="stretch" class="panel-tabs">
      <TabPane name="node" :tab="t('flows.tabNode')">
        <NodePanel />
      </TabPane>
      <TabPane name="flow" :tab="t('flows.tabFlow')">
        <FlowPanel />
      </TabPane>
    </Tabs>
  </aside>
</template>

<style scoped>
.panel {
  width: 340px;
  flex: none;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 0 16px 24px;
  border-left: 1px solid var(--line);
  background: var(--flow-node-bg);
}

/* The Node and Flow tabs stay in view while the settings scroll. */
.panel-tabs :deep(.mu-tabs__bar) {
  position: sticky;
  top: 0;
  z-index: 2;
  margin: 0 -16px;
  padding: 0 16px;
  background: var(--flow-node-bg);
}
</style>
