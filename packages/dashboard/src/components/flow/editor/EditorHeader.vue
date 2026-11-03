<script setup lang="ts">
/** The editor's top bar: the flow's name, where it runs, whether it is on, the panels and saving. */
import { ArrowBackOutline, ContractOutline, ExpandOutline } from '@vicons/ionicons5'
import { NButton, NIcon, NInput, NSelect, NSwitch, NTag, NTooltip } from 'naive-ui'
import { useEditor } from './editor'
import PanelIcon from './PanelIcon.vue'

const {
  t, router, name, bots, enabled, toggling, currentAdapter, adapterOptions, setAdapter, botOptions, setEnabled,
  errorCount, warningCount, dirty, saving, save, showPalette, showPanel, togglePalette, togglePanel, immersive, toggleImmersive,
} = useEditor()
</script>

<template>
  <header class="editor-head">
    <NButton quaternary circle :aria-label="t('common.back')" @click="router.push('/flows')">
      <template #icon><NIcon><ArrowBackOutline /></NIcon></template>
    </NButton>
    <NInput v-model:value="name" class="name-input" :placeholder="t('common.name')" />
    <NSelect
      :value="currentAdapter ?? null"
      class="adapter-select"
      :options="adapterOptions"
      :placeholder="t('flows.adapterAny')"
      :clearable="adapterOptions.length > 1"
      :title="t('flows.adapter')"
      data-agent-target="flows.adapter"
      @update:value="setAdapter"
    />
    <NSelect
      v-model:value="bots"
      class="bots-select"
      multiple
      :options="botOptions"
      :placeholder="t('flows.runsOnNone')"
      max-tag-count="responsive"
      data-agent-target="flows.bots"
    />
    <NSwitch class="enabled" :value="enabled" :loading="toggling" :title="enabled ? t('flows.enabledHint') : t('flows.disabledHint')" data-agent-target="flows.enabled" @update:value="setEnabled">
      <template #checked>{{ t('flows.on') }}</template>
      <template #unchecked>{{ t('flows.off') }}</template>
    </NSwitch>
    <NTag v-if="errorCount" type="error" size="small" :bordered="false">{{ t('flows.errorCount', errorCount) }}</NTag>
    <NTag v-else-if="warningCount" type="warning" size="small" :bordered="false">{{ t('flows.warningCount', warningCount) }}</NTag>
    <span class="spacer" />
    <span class="save-state">{{ dirty ? t('flows.unsavedShort') : t('flows.savedShort') }}</span>
    <div class="view-tools" role="group" :aria-label="t('flows.layout')">
      <NTooltip :show-arrow="false">
        <template #trigger>
          <NButton quaternary size="small" :class="{ on: showPalette }" :aria-label="t('flows.palette')" :aria-pressed="showPalette" @click="togglePalette">
            <template #icon><PanelIcon side="left" :open="showPalette" /></template>
          </NButton>
        </template>
        {{ showPalette ? t('flows.hidePalette') : t('flows.showPalette') }}
      </NTooltip>
      <NTooltip :show-arrow="false">
        <template #trigger>
          <NButton quaternary size="small" :class="{ on: showPanel }" :aria-label="t('flows.panel')" :aria-pressed="showPanel" @click="togglePanel">
            <template #icon><PanelIcon side="right" :open="showPanel" /></template>
          </NButton>
        </template>
        {{ showPanel ? t('flows.hidePanel') : t('flows.showPanel') }}
      </NTooltip>
      <NTooltip :show-arrow="false">
        <template #trigger>
          <NButton quaternary size="small" :class="{ on: immersive }" :aria-label="immersive ? t('flows.exitFullscreen') : t('flows.fullscreen')" :aria-pressed="immersive" @click="toggleImmersive">
            <template #icon><NIcon><ContractOutline v-if="immersive" /><ExpandOutline v-else /></NIcon></template>
          </NButton>
        </template>
        {{ immersive ? t('flows.exitFullscreenHint') : t('flows.fullscreenHint') }}
      </NTooltip>
    </div>
    <NButton type="primary" :loading="saving" :disabled="!dirty" data-agent-target="flows.save" @click="save">{{ t('common.save') }}</NButton>
  </header>
</template>

<style scoped>
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

.view-tools :deep(.n-button) {
  width: 30px;
  padding: 0;
  color: var(--fg3);
}

.view-tools :deep(.n-button.on) {
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
