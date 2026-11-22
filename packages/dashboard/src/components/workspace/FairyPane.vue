<script setup lang="ts">
import { onMounted, provide } from 'vue'
import { FAIRY_CONVERSATION, useFairyPane } from '../../stores/fairy'
import { workspace } from '../../stores/workspace'
import FairyDock from '../FairyDock.vue'

/** One conversation of the workspace; the main pane shares its conversation with the dock. */
const props = defineProps<{ pane: 'main' | 'split'; closable?: boolean }>()
const emit = defineEmits<{ close: [] }>()

const conversation = useFairyPane(props.pane)
provide(FAIRY_CONVERSATION, conversation)
conversation.bind()
onMounted(() => {
  conversation.refreshSessions().catch(() => {})
  conversation.refreshPickers().catch(() => {})
  if (conversation.current && !conversation.items.length) conversation.load(conversation.current).catch(() => conversation.newChat())
})
</script>

<template>
  <section
    class="pane"
    :class="{ focused: workspace.layout.split && workspace.focused === pane }"
    @pointerdown="workspace.focused = pane"
    @focusin="workspace.focused = pane"
  >
    <FairyDock :closable="closable" @close="emit('close')" />
  </section>
</template>

<style scoped>
.pane {
  position: relative;
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.pane.focused::after {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 2px;
  background: var(--primary);
  pointer-events: none;
}
</style>
