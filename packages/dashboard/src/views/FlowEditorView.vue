<script setup lang="ts">
/**
 * The flow editor: a canvas of nodes between the node palette and the inspector, with run logs and
 * tests below. Its behaviour lives in components/flow/editor; this file lays the parts out.
 */
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { VueFlow } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import { NDropdown } from 'naive-ui'
import { createFlowEditor } from '../components/flow/editor/editor'
import EditorHeader from '../components/flow/editor/EditorHeader.vue'
import GroupFrames from '../components/flow/editor/GroupFrames.vue'
import InspectorPanel from '../components/flow/editor/InspectorPanel.vue'
import RunBanners from '../components/flow/editor/RunBanners.vue'
import { isBox } from '../components/flow/editor/state'
import FlowMiniMap from '../components/flow/FlowMiniMap.vue'
import NodePalette from '../components/flow/NodePalette.vue'
import NodePicker from '../components/flow/NodePicker.vue'
import RunLogs from '../components/flow/RunLogs.vue'
import TestPanel from '../components/flow/TestPanel.vue'
import { useTheme } from '../theme'

const { isDark } = useTheme()
const {
  t, flowId, root, canvas, logs, narrow, immersive, loaded, types, nodes, edges, realNodes, selectedId,
  showPalette, showPanel, showLogs, logsTab, logsRun, runs, testing, testStatus, currentAdapter, adapterName, nodeName, nodeType,
  nodeTypes, extent, minimapColor, addNode, onDrop, trackPointer,
  isValidConnection, onEdgeUpdateStart, onEdgeUpdate, onEdgeUpdateEnd, onConnect, onConnectStart, onConnectEnd,
  onNodesInitialized, onNodeClick, onNodeDragStop, toggleGroup, openMenu, onNodeContextMenu,
  menu, menuOptions, onMenuSelect, onMenuClickOutside, picker, pickerTypes, pickerTitle, onPick,
  test, quickTests, liveRuns, schedules, runTest, clearRuns, showTrace, selectFromLogs, nodeOptions, execOptions, saveBeforeTests, showCaseTrace,
} = createFlowEditor()
</script>

<template>
  <div
    ref="root"
    class="editor"
    :class="{ dark: isDark, narrow, immersive }"
    :style="{ '--flow-node-bg': isDark ? '#26262c' : '#fff', '--flow-node-fg': isDark ? '#e6e6e6' : '#222', '--flow-accent-strength': isDark ? '62%' : '100%' }"
  >
    <EditorHeader />
    <RunBanners />

    <div class="editor-body">
      <NodePalette
        v-if="showPalette"
        class="side"
        :types="[...types.values()]"
        :adapter="currentAdapter"
        :adapter-name="adapterName"
        @add="(typeId: string) => addNode(typeId)"
      />

      <div class="main">
        <div ref="canvas" class="canvas" @dragover.prevent @drop.prevent="onDrop" @pointermove="trackPointer">
          <VueFlow
            id="flow-editor"
            v-model:nodes="nodes"
            v-model:edges="edges"
            :node-types="nodeTypes"
            :is-valid-connection="isValidConnection"
            :delete-key-code="['Delete', 'Backspace']"
            :min-zoom="0.2"
            :max-zoom="2"
            :default-edge-options="{ type: 'default' }"
            :edges-updatable="true"
            :translate-extent="extent"
            @edge-update-start="onEdgeUpdateStart"
            @edge-update="onEdgeUpdate"
            @edge-update-end="onEdgeUpdateEnd"
            @connect="onConnect"
            @connect-start="onConnectStart"
            @connect-end="onConnectEnd"
            @nodes-initialized="onNodesInitialized"
            @node-click="onNodeClick"
            @node-drag-stop="onNodeDragStop"
            @node-double-click="({ node }) => isBox(node) && node.data?.groupId && toggleGroup(node.data.groupId)"
            @pane-click="selectedId = undefined"
            @pane-context-menu="openMenu($event, 'pane')"
            @node-context-menu="onNodeContextMenu"
            @selection-context-menu="({ event, nodes: picked }) => openMenu(event, 'selection', undefined, picked.map((node) => node.id))"
            @edge-context-menu="({ event, edge }) => openMenu(event, 'edge', edge.id)"
          >
            <template #zoom-pane>
              <GroupFrames />
            </template>
            <Background :gap="20" :size="1.4" :pattern-color="isDark ? '#5c5c66' : '#bdbdbd'" />
            <Controls />
            <FlowMiniMap v-if="!narrow && realNodes.length" :extent="extent" :node-color="minimapColor" :dark="isDark" />
          </VueFlow>
          <div v-if="loaded && !nodes.length" class="canvas-empty">{{ t('flows.emptyCanvas') }}</div>
          <NDropdown
            trigger="manual"
            placement="bottom-start"
            size="small"
            :show="!!menu"
            :x="menu?.x ?? 0"
            :y="menu?.y ?? 0"
            :options="menuOptions"
            @select="onMenuSelect"
            @clickoutside="onMenuClickOutside"
          />
          <NodePicker
            v-if="picker"
            :key="`${picker.x},${picker.y}`"
            :types="pickerTypes"
            :x="picker.x"
            :y="picker.y"
            :title="pickerTitle"
            :adapter="currentAdapter"
            :adapter-name="adapterName"
            @pick="onPick"
            @close="picker = undefined"
          />
        </div>
        <RunLogs
          ref="logs"
          v-model:test="test"
          v-model:open="showLogs"
          v-model:tab="logsTab"
          v-model:current="logsRun"
          :live="liveRuns"
          :quick="quickTests"
          :tests="testStatus"
          :runs="runs"
          :schedules="schedules"
          :testing="testing"
          :node-name="nodeName"
          :node-type="nodeType"
          @run="runTest()"
          @clear="clearRuns"
          @show="showTrace"
          @select="selectFromLogs"
        >
          <template #tests>
            <TestPanel
              :flow-id="flowId"
              :nodes="nodeOptions"
              :exec-options="execOptions"
              :schedules="schedules"
              :prepare="saveBeforeTests"
              @trace="showCaseTrace"
              @status="(value) => (testStatus = value)"
            />
          </template>
        </RunLogs>
      </div>

      <InspectorPanel v-if="showPanel" />
    </div>
  </div>
</template>

<style scoped>
/* Category colors are tuned for light backgrounds; on dark ones icons mix in the text color to stay legible. */
.editor :deep([style*='--accent']) {
  --accent-fg: color-mix(in srgb, var(--accent) var(--flow-accent-strength, 100%), var(--flow-node-fg, #222));
}

.editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  container: flow-editor / inline-size;
}

/* Full window: the editor covers the app's sidebar, top bar and Agent until Esc or the button. */
.editor.immersive {
  position: fixed;
  inset: 0;
  z-index: 100;
  height: auto;
  background: var(--bg);
}

/* A selected connection stands out, so it can be deleted with Delete or from its menu. */
.canvas :deep(.vue-flow__edge.selected path.vue-flow__edge-path) {
  stroke: var(--primary) !important;
  stroke-width: 3 !important;
}

/* The path a run takes round a skipped step. */
.canvas :deep(.vue-flow__edge.edge-bypass) {
  pointer-events: none;
}

/* A running edge is a moving dashed line; Vue Flow animates the dashes. */
.canvas :deep(.vue-flow__edge.animated path.vue-flow__edge-path) {
  stroke-dasharray: 6 4;
  animation-duration: 0.6s;
}

.canvas :deep(.vue-flow__edge.edge-ok path.vue-flow__edge-path),
.canvas :deep(.vue-flow__edge.edge-error path.vue-flow__edge-path) {
  transition: stroke 0.2s;
}

.editor-body {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.canvas {
  flex: 1;
  min-height: 0;
  position: relative;
}

.canvas-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  opacity: 0.55;
  font-size: 14px;
  padding: 24px;
  text-align: center;
}

/* On a narrow screen the palette and the inspector float over the canvas. */
.narrow .side {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 10;
  background: var(--flow-node-bg);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}

.narrow .palette {
  left: 0;
}

.narrow .panel {
  right: 0;
  width: min(340px, 90vw);
}

.dark :deep(.vue-flow__controls-button) {
  background: #2c2c32;
  border-bottom-color: #3a3a40;
  fill: #ddd;
}

.dark :deep(.vue-flow__minimap) {
  background: #1f1f23;
}
</style>
