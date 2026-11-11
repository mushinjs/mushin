<script setup lang="ts">
/** Undo, redo, and the list of steps taken on this flow, to go back or forward to any of them. */
import { Button, Popover, Tooltip } from '@mushinjs/ui'
import { computed, ref } from 'vue'
import { useEditor } from './editor'
import { LIMIT } from './useHistory'

const { t, locale, historyEntries, historyIndex, canUndo, canRedo, undoLabel, redoLabel, undo, redo, goTo, clearHistory, stepLabel } = useEditor()

const open = ref(false)
/** Newest first, as the list shows them. */
const steps = computed(() => historyEntries.value.map((entry, index) => ({ entry, index })).reverse())

function when(at: number) {
  const date = new Date(at)
  const today = new Date().toDateString() === date.toDateString()
  return date.toLocaleString(locale.value, today ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="history-tools" role="group" :aria-label="t('flows.history.title')">
    <Tooltip>
      <template #trigger>
        <Button quaternary size="small" :disabled="!canUndo" :aria-label="t('flows.history.undo')" data-agent-target="flows.undo" @click="undo" icon="i-lucide-undo-2" />
      </template>
      {{ canUndo ? t('flows.history.undoStep', { step: undoLabel }) : t('flows.history.nothingToUndo') }}
    </Tooltip>
    <Tooltip>
      <template #trigger>
        <Button quaternary size="small" :disabled="!canRedo" :aria-label="t('flows.history.redo')" data-agent-target="flows.redo" @click="redo" icon="i-lucide-redo-2" />
      </template>
      {{ canRedo ? t('flows.history.redoStep', { step: redoLabel }) : t('flows.history.nothingToRedo') }}
    </Tooltip>
    <Popover v-model:show="open" placement="bottom" align="end" :padded="false" :width="300">
      <template #trigger>
        <Button quaternary size="small" :class="{ on: open }" :aria-label="t('flows.history.title')" :title="t('flows.history.title')" icon="i-lucide-history" />
      </template>
      <div class="history-pop">
        <div class="history-head">
          <strong>{{ t('flows.history.title') }}</strong>
          <span class="muted">{{ t('flows.history.kept', { count: LIMIT }) }}</span>
          <span class="spacer" />
          <Button text size="tiny" :disabled="historyEntries.length < 2" @click="clearHistory">{{ t('flows.history.clear') }}</Button>
        </div>
        <ol class="history-list">
          <li v-for="{ entry, index } in steps" :key="`${index}:${entry.at}`">
            <button
              type="button"
              class="step"
              :class="{ current: index === historyIndex, undone: index > historyIndex }"
              :aria-current="index === historyIndex ? 'step' : undefined"
              @click="goTo(index)"
            >
              <span class="dot" />
              <span class="label">{{ stepLabel(entry) }}</span>
              <span class="time">{{ when(entry.at) }}</span>
            </button>
          </li>
        </ol>
      </div>
    </Popover>
  </div>
</template>

<style scoped>
.history-tools {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.08);
}

.history-tools :deep(.mu-btn) {
  width: 30px;
  padding: 0;
  color: var(--fg3);
}

.history-tools :deep(.mu-btn:not(:disabled):hover),
.history-tools :deep(.mu-btn.on) {
  color: var(--fg);
}

.history-pop {
  display: flex;
  flex-direction: column;
  max-height: min(420px, 70vh);
}

.history-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}

.spacer {
  flex: 1;
}

.muted {
  opacity: 0.6;
  font-size: 12px;
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 4px;
  overflow-y: auto;
}

.step {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.step:hover {
  background: rgba(127, 127, 127, 0.1);
}

.step.current {
  background: color-mix(in srgb, var(--primary) 14%, transparent);
}

/* Steps after the current one were undone; going to one redoes up to it. */
.step.undone {
  opacity: 0.5;
}

.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  opacity: 0.6;
}

.step.current .dot {
  border-color: var(--primary);
  background: var(--primary);
  opacity: 1;
}

.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time {
  flex: none;
  font-size: 11px;
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
}
</style>
