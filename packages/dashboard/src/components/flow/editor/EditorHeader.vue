<script setup lang="ts">
/** The editor's top bar: the flow's name, where it runs, whether it is on, the panels and saving. */
import { Button, Input, Select, Tag, Toggle, Tooltip } from '@mushin/ui'
import { computed } from 'vue'
import { useEditor } from './editor'
import HistoryTools from './HistoryTools.vue'
import PanelIcon from './PanelIcon.vue'
import SamplePicker from './SamplePicker.vue'

const {
  t, router, name, bots, enabled, toggling, currentAdapter, adapterOptions, setAdapter, botOptions, setEnabled,
  errorCount, warningCount, dirty, saving, save, showPalette, showPanel, togglePalette, togglePanel, immersive, toggleImmersive,
  issuesByNode, order, selectedId, selectNode, openPanel, focusNode,
} = useEditor()

/** Nodes with problems, in canvas order. */
const problemNodes = computed(() => [...issuesByNode.value.keys()].filter((id) => order.value.has(id)).sort((a, b) => order.value.get(a)! - order.value.get(b)!))
const problemLevel = computed(() => (problemNodes.value.some((id) => issuesByNode.value.get(id)!.some((issue) => issue.severity === 'error')) ? 'error' : 'warning'))

/** Selects the next node with problems after the selected one, and brings it into view. */
function nextProblem() {
  const list = problemNodes.value
  if (!list.length) return
  const id = list[(list.indexOf(selectedId.value ?? '') + 1) % list.length]
  selectNode(id)
  openPanel()
  focusNode(id)
}
</script>

<template>
  <header class="editor-head">
    <Button quaternary circle :aria-label="t('common.back')" @click="router.push('/flows')" icon="i-lucide-arrow-left" />
    <Input v-model:value="name" class="name-input" :placeholder="t('common.name')" />
    <Select
      :value="currentAdapter ?? null"
      class="adapter-select"
      :options="adapterOptions"
      :placeholder="t('flows.adapterAny')"
      :clearable="adapterOptions.length > 1"
      :title="t('flows.adapter')"
      data-agent-target="flows.adapter"
      @update:value="setAdapter"
    />
    <Select
      v-model:value="bots"
      class="bots-select"
      multiple
      :options="botOptions"
      :placeholder="t('flows.runsOnNone')"
      max-tag-count="responsive"
      data-agent-target="flows.bots"
    />
    <Toggle class="enabled" variant="button" size="small" :value="enabled" :loading="toggling" :title="enabled ? t('flows.enabledHint') : t('flows.disabledHint')" data-agent-target="flows.enabled" @update:value="setEnabled" />
    <button v-if="problemNodes.length" type="button" class="problems" :title="t('flows.nextProblem')" data-agent-target="flows.problems" @click="nextProblem">
      <Tag :type="problemLevel" size="small">{{ t('flows.nodesWithProblems', problemNodes.length) }}</Tag>
    </button>
    <Tag v-else-if="errorCount" type="error" size="small">{{ t('flows.errorCount', errorCount) }}</Tag>
    <Tag v-else-if="warningCount" type="warning" size="small">{{ t('flows.warningCount', warningCount) }}</Tag>
    <span class="spacer" />
    <SamplePicker />
    <HistoryTools />
    <span class="save-state">{{ dirty ? t('flows.unsavedShort') : t('flows.savedShort') }}</span>
    <div class="view-tools" role="group" :aria-label="t('flows.layout')">
      <Tooltip>
        <template #trigger>
          <Button quaternary size="small" :class="{ on: showPalette }" :aria-label="t('flows.palette')" :aria-pressed="showPalette" @click="togglePalette">
            <template #icon><PanelIcon side="left" :open="showPalette" /></template>
          </Button>
        </template>
        {{ showPalette ? t('flows.hidePalette') : t('flows.showPalette') }}
      </Tooltip>
      <Tooltip>
        <template #trigger>
          <Button quaternary size="small" :class="{ on: showPanel }" :aria-label="t('flows.panel')" :aria-pressed="showPanel" @click="togglePanel">
            <template #icon><PanelIcon side="right" :open="showPanel" /></template>
          </Button>
        </template>
        {{ showPanel ? t('flows.hidePanel') : t('flows.showPanel') }}
      </Tooltip>
      <Tooltip>
        <template #trigger>
          <Button quaternary size="small" :class="{ on: immersive }" :aria-label="immersive ? t('flows.exitFullscreen') : t('flows.fullscreen')" :aria-pressed="immersive" @click="toggleImmersive">
            <template #icon><span :class="immersive ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'" /></template>
          </Button>
        </template>
        {{ immersive ? t('flows.exitFullscreenHint') : t('flows.fullscreenHint') }}
      </Tooltip>
    </div>
    <Button type="primary" :loading="saving" :disabled="!dirty" data-agent-target="flows.save" @click="save">{{ t('common.save') }}</Button>
  </header>
</template>

<style scoped>
.problems {
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
}

.editor-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(127, 127, 127, 0.18);
}

.name-input {
  flex: 0 1 220px;
  min-width: 110px;
}

.adapter-select {
  flex: 0 1 150px;
  min-width: 110px;
}

.bots-select {
  flex: 0 1 260px;
  min-width: 120px;
}

/* The switch carries its own label; squeezing it would cut the words off. */
.enabled {
  flex: none;
}

.spacer {
  flex: 1;
}

.save-state {
  font-size: 12px;
  opacity: 0.6;
  white-space: nowrap;
}

.view-tools {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.08);
}

.view-tools :deep(.mu-btn) {
  width: 30px;
  padding: 0;
  color: var(--fg3);
}

.view-tools :deep(.mu-btn.on) {
  color: var(--fg);
}

/* Sized by the editor, not the window: beside the app's sidebar and the Agent it can be narrow. */
@container flow-editor (max-width: 900px) {
  .editor-head {
    flex-wrap: wrap;
  }

  .name-input,
  .bots-select {
    flex-grow: 1;
  }
}
</style>
