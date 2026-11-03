<script setup lang="ts">
/** Bars above the canvas: a test run paused at a breakpoint, and a run opened from a bot's run list. */
import { CloseOutline, PlayOutline, StopCircleOutline } from '@vicons/ionicons5'
import { NButton, NIcon } from 'naive-ui'
import { RouterLink } from 'vue-router'
import { isLive } from '../../../stores/runs'
import { runColors, useRunText } from '../../runs/useRunText'
import { useEditor } from './editor'

const { t, paused, viewing, viewingBot, now, nodeName, debug, stopViewing, closeRun } = useEditor()
const runText = useRunText()
</script>

<template>
  <div v-if="paused" class="run-banner" :style="{ '--state': '#f0a020' }" role="status">
    <span class="run-state"><span class="run-dot live" />{{ t('flows.pausedAt', { node: nodeName(paused.nodeId) }) }}</span>
    <span class="run-what muted">{{ t('flows.pausedHint') }}</span>
    <span class="spacer" />
    <NButton size="small" type="primary" @click="debug('continue')">
      <template #icon><NIcon><PlayOutline /></NIcon></template>
      {{ t('flows.debugContinue') }}
    </NButton>
    <NButton size="small" @click="debug('step')">{{ t('flows.debugStep') }}</NButton>
    <NButton size="small" type="error" secondary @click="debug('stop')">
      <template #icon><NIcon><StopCircleOutline /></NIcon></template>
      {{ t('flows.debugStop') }}
    </NButton>
  </div>

  <div v-if="viewing" class="run-banner" :style="{ '--state': runColors[viewing.status] }" role="status">
    <span class="run-state"><span class="run-dot" :class="{ live: isLive(viewing) }" />{{ runText.statusText(viewing) }}</span>
    <span class="run-what">{{ t('runs.viewing', { bot: viewingBot?.name ?? viewing.botId }) }} · {{ viewing.source === 'message' ? t('runs.saidBy', { name: runText.userName(viewing), text: viewing.text }) : `${t(`runs.source.${viewing.source}`)} ${viewing.text}` }}</span>
    <span class="muted">{{ runText.duration((viewing.endedAt ?? now) - viewing.startedAt) }}</span>
    <span v-if="viewing.status === 'stopped'" class="run-error">{{ runText.stoppedByText(viewing) }}</span>
    <span v-else-if="viewing.error" class="run-error" :title="viewing.error">{{ viewing.error }}</span>
    <span class="spacer" />
    <NButton v-if="isLive(viewing)" size="small" type="error" secondary @click="stopViewing">
      <template #icon><NIcon><StopCircleOutline /></NIcon></template>
      {{ t('runs.stop') }}
    </NButton>
    <RouterLink :to="`/bots/${viewing.botId}/runs`" class="run-link">{{ t('runs.allRuns') }}</RouterLink>
    <NButton size="small" quaternary circle :aria-label="t('common.close')" @click="closeRun">
      <template #icon><NIcon><CloseOutline /></NIcon></template>
    </NButton>
  </div>
</template>

<style scoped>
.run-banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding: 6px 14px;
  border-bottom: 1px solid rgba(127, 127, 127, 0.16);
  border-left: 3px solid var(--state);
  background: color-mix(in srgb, var(--state) 7%, transparent);
  font-size: 13px;
}

.run-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--state);
  font-weight: 600;
}

.run-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--state);
}

.run-dot.live {
  animation: run-pulse 1.4s ease-in-out infinite;
}

@keyframes run-pulse {
  50% {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--state) 25%, transparent);
  }
}

.run-what {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-error {
  color: var(--bad);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-link {
  font-size: 13px;
  color: inherit;
  opacity: 0.75;
}

.run-link:hover {
  opacity: 1;
}

.spacer {
  flex: 1;
}

.muted {
  opacity: 0.65;
  font-size: 13px;
}
</style>
