<script setup lang="ts">
/** Dashed frames drawn behind grouped nodes on the canvas; the header moves, renames and folds the group. */
import { ChevronDownOutline } from '@vicons/ionicons5'
import { NIcon } from 'naive-ui'
import { useEditor } from './editor'

const { t, frames, renaming, startGroupDrag, renameGroup, openMenu, toggleGroup } = useEditor()
</script>

<template>
  <div
    v-for="frame in frames"
    :key="frame.group.id"
    class="flow-group"
    :style="frame.style"
  >
    <div
      class="flow-group-head"
      :title="t('flows.groupHint')"
      @pointerdown.stop="startGroupDrag($event, frame.group)"
      @dblclick.stop="renaming = frame.group.id"
      @contextmenu.stop="openMenu($event, 'group', frame.group.id, frame.group.nodes)"
    >
      <input
        v-if="renaming === frame.group.id"
        class="flow-group-rename nodrag"
        :value="frame.group.label ?? ''"
        :placeholder="t('flows.groupDefault')"
        autofocus
        @pointerdown.stop
        @keydown.enter="renameGroup(frame.group.id, ($event.target as HTMLInputElement).value)"
        @keydown.esc="renaming = undefined"
        @blur="renameGroup(frame.group.id, ($event.target as HTMLInputElement).value)"
      >
      <span v-else class="flow-group-label">{{ frame.group.label || t('flows.groupDefault') }}</span>
      <span class="flow-group-count">{{ frame.group.nodes.length }}</span>
      <button
        type="button"
        class="flow-group-fold nodrag"
        :title="t('flows.menuCollapse')"
        @pointerdown.stop
        @click.stop="toggleGroup(frame.group.id)"
      >
        <NIcon :size="13"><ChevronDownOutline /></NIcon>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Groups: a dashed frame behind their nodes; the header moves the group. */
.flow-group {
  position: absolute;
  top: 0;
  left: 0;
  z-index: -1;
  box-sizing: border-box;
  border: 1.5px dashed rgba(127, 127, 127, 0.55);
  border-radius: 14px;
  background: rgba(127, 127, 127, 0.05);
  pointer-events: none;
}

.flow-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--flow-node-fg, #222);
  opacity: 0.75;
  cursor: grab;
  pointer-events: all;
  user-select: none;
}

.flow-group-head:active {
  cursor: grabbing;
}

.flow-group-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flow-group-count {
  font-weight: 500;
  opacity: 0.6;
}

.flow-group-fold {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: auto;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.flow-group-fold:hover {
  background: rgba(127, 127, 127, 0.18);
}

.flow-group-rename {
  font: inherit;
  width: 160px;
  padding: 1px 6px;
  border-radius: 6px;
  border: 1px solid rgba(127, 127, 127, 0.4);
  background: var(--flow-node-bg, #fff);
  color: inherit;
}
</style>
