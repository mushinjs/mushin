<script setup lang="ts">
/** The node's inputs / outputs tab: where its values come from and go, and its last run. */
import { portColors } from '../../../flow'
import { useEditor } from './editor'
import { useNodeWiring } from './useNodeWiring'

const { t, portLabel, lastStep } = useEditor()
const { wiring } = useNodeWiring()
</script>

<template>
  <template v-if="wiring">
    <h4 class="section">{{ t('flows.ioInputs') }}</h4>
    <p v-if="!wiring.inputs.length" class="muted small">{{ t('flows.ioNone') }}</p>
    <div v-for="item in wiring.inputs" :key="item.port.name" class="io-row">
      <span class="io-dot" :style="{ background: portColors[item.port.type] }" />
      <span class="io-name">{{ portLabel(item.port) }}</span>
      <code v-if="item.binding" class="io-link">{{ item.binding }}</code>
      <span v-else class="io-link muted">{{ t('flows.ioUnset') }}</span>
    </div>
    <h4 class="section">{{ t('flows.ioBranches') }}</h4>
    <p v-if="!wiring.exec.length" class="muted small">{{ t('flows.ioNone') }}</p>
    <div v-for="item in wiring.exec" :key="`exec-${item.name}`" class="io-row">
      <span class="io-arrow" />
      <span class="io-name">{{ item.name }}</span>
      <span class="io-link" :class="{ muted: !item.to.length }">{{ item.to.join(', ') || t('flows.ioUnlinked') }}</span>
    </div>
    <h4 class="section">{{ t('flows.ioOutputs') }}</h4>
    <p v-if="!wiring.outputs.length" class="muted small">{{ t('flows.ioNone') }}</p>
    <div v-for="item in wiring.outputs" :key="item.port.name" class="io-row">
      <span class="io-dot" :style="{ background: portColors[item.port.type] }" />
      <span class="io-name">{{ portLabel(item.port) }}</span>
      <code class="io-ref">{{ item.ref }}</code>
      <span class="io-link" :class="{ muted: !item.readers.length }">{{ item.readers.join(', ') || t('flows.ioUnread') }}</span>
    </div>
    <h4 class="section">{{ t('flows.ioLastRun') }}</h4>
    <p v-if="!lastStep" class="muted small">{{ t('flows.ioNotRun') }}</p>
    <template v-else>
      <div v-if="lastStep.step.error" class="step-error">{{ lastStep.step.error }}</div>
      <div class="muted small">{{ t('flows.logsInput') }}</div>
      <pre class="json">{{ lastStep.step.inputs && Object.keys(lastStep.step.inputs).length ? JSON.stringify(lastStep.step.inputs, null, 2) : '—' }}</pre>
      <div class="muted small">{{ t('flows.logsOutput') }}</div>
      <pre class="json">{{ lastStep.step.outputs && Object.keys(lastStep.step.outputs).length ? JSON.stringify(lastStep.step.outputs, null, 2) : '—' }}</pre>
    </template>
  </template>
</template>

<style scoped src="./panel.css"></style>

<style scoped>
.io-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 13px;
  border-bottom: 1px dashed rgba(127, 127, 127, 0.16);
}

.io-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.io-arrow {
  width: 8px;
  height: 10px;
  flex: none;
  background: #8c8c8c;
  clip-path: polygon(0 0, 100% 50%, 0 100%);
}

.io-name {
  flex: none;
  font-weight: 500;
}

.io-ref {
  font-size: 11px;
  color: var(--primary);
  white-space: nowrap;
}

.io-link {
  flex: 1;
  min-width: 0;
  text-align: right;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.json {
  margin: 4px 0 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.1);
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow: auto;
  scrollbar-gutter: stable;
}

.step-error {
  color: var(--bad);
  font-size: 12px;
}
</style>
