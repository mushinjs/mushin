<script setup lang="ts">
import { CheckmarkOutline, CloseOutline, PlayOutline } from '@vicons/ionicons5'
import { Handle, Position } from '@vue-flow/core'
import { NIcon, NSpin } from 'naive-ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { categoryColors, configSummary, EXEC_IN, execOutHandle, portsOf, wholeRef } from '../../flow'
import type { PortDef } from '../../types'
import { localize } from '../../utils'
import { type CanvasNodeData, useFlowEditor } from './context'
import { nodeIcon } from './icons'

const props = defineProps<{ id: string; data: CanvasNodeData; selected: boolean }>()
const { t, locale } = useI18n()
const editor = useFlowEditor()

const info = computed(() => editor.types.value.get(props.data.typeId))
const ports = computed(() => (info.value ? portsOf(info.value, props.data.config) : undefined))
const typeTitle = computed(() => localize(info.value?.title, locale.value) || props.data.typeId)
const issues = computed(() => editor.issuesByNode.value.get(props.id) ?? [])
const issueLevel = computed(() => (issues.value.some((issue) => issue.severity === 'error') ? 'error' : issues.value.length ? 'warning' : undefined))
const run = computed(() => editor.highlight.value.nodes.get(props.id))
const color = computed(() => (info.value ? categoryColors[info.value.category] : '#8c8c8c'))
const icon = computed(() => nodeIcon(props.data.typeId, info.value?.category))
const number = computed(() => String((editor.order.value.get(props.id) ?? 0) + 1).padStart(2, '0'))
const executing = computed(() => editor.executing.value === props.id)

// A node with only `next` keeps its exec output on the header; branching nodes list one row per branch, like CASE / ELSE.
const execOut = computed(() => ports.value?.execOut ?? [])
const branches = computed(() => (execOut.value.length === 1 && execOut.value[0] === 'next' ? [] : execOut.value))

const portLabel = (port: PortDef) => localize(port.title, locale.value) || port.name

/** Bound inputs: a lone reference shows as a variable chip, anything else as text. */
const inputRows = computed(() => (ports.value?.inputs ?? []).flatMap((port) => {
  const binding = props.data.inputs?.[port.name]?.trim()
  if (!binding) return []
  const ref = wholeRef(binding)
  return [{
    key: port.name,
    label: portLabel(port),
    ref: ref && { node: ref.head === 'sys' ? t('flows.varsMessage') : editor.nodeName(ref.head), name: ref.name },
    text: binding,
  }]
}))
const summary = computed(() => (info.value ? configSummary(info.value, props.data.config, locale.value, inputRows.value.length ? 1 : 2) : []))
</script>

<template>
  <div
    class="flow-node"
    :class="{ selected, [`issue-${issueLevel}`]: !!issueLevel, [`run-${run}`]: !!run, executing }"
    :style="{ '--accent': color }"
    :title="issues.map((issue) => issue.message).join('\n') || undefined"
  >
    <Handle v-if="ports?.execIn" :id="EXEC_IN" type="target" :position="Position.Left" class="handle head-handle" />
    <header class="flow-node-head">
      <span class="icon"><NIcon :size="15"><component :is="icon" /></NIcon></span>
      <span class="name">{{ data.label || typeTitle }}</span>
      <span class="number">{{ number }}</span>
      <span v-if="issueLevel" class="badge" :class="issueLevel">!</span>
      <NSpin v-else-if="run === 'running'" :size="12" class="run-spin" />
      <span v-else-if="run" class="run-mark" :class="run">
        <NIcon :size="11"><CheckmarkOutline v-if="run === 'ok'" /><CloseOutline v-else /></NIcon>
      </span>
      <button
        v-if="info"
        type="button"
        class="run-step nodrag"
        :title="t('flows.executeStep')"
        :disabled="!!editor.executing.value"
        @click.stop="editor.execute(id)"
      >
        <NSpin v-if="executing" :size="12" />
        <NIcon v-else :size="13"><PlayOutline /></NIcon>
      </button>
    </header>
    <Handle v-if="execOut.length && !branches.length" :id="execOutHandle('next')" type="source" :position="Position.Right" class="handle head-handle" />

    <div v-if="!info" class="unknown">{{ t('flows.unknownType', { type: data.typeId }) }}</div>

    <div v-if="inputRows.length || summary.length" class="rows">
      <div v-for="row in inputRows" :key="`in-${row.key}`" class="row">
        <span class="row-label">{{ row.label }}</span>
        <span v-if="row.ref" class="var-chip">
          <span class="var-node">{{ row.ref.node }}</span>
          <span class="var-sep">/</span>
          <span class="var-x">(x)</span>{{ row.ref.name }}
        </span>
        <span v-else class="row-value">{{ row.text }}</span>
      </div>
      <div v-for="line in summary" :key="`cfg-${line.key}`" class="row">
        <span class="row-label">{{ line.label }}</span>
        <span class="row-value">{{ line.value }}</span>
      </div>
    </div>

    <div v-if="branches.length" class="branches">
      <div v-for="name in branches" :key="name" class="branch">
        <span class="branch-name">{{ name }}</span>
        <Handle :id="execOutHandle(name)" type="source" :position="Position.Right" class="handle branch-handle" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.flow-node {
  position: relative;
  width: 240px;
  border-radius: 12px;
  background: var(--flow-node-bg, #fff);
  border: 1.5px solid rgba(127, 127, 127, 0.22);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
  font-size: 12px;
  color: var(--flow-node-fg, #222);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.flow-node:hover {
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
}

.flow-node.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent), 0 6px 18px rgba(0, 0, 0, 0.14);
}

.flow-node.issue-error {
  border-color: #d03050;
}

.flow-node.issue-warning {
  border-color: #d08a00;
}

.flow-node.run-ok {
  border-color: #18a058;
}

.flow-node.run-error {
  border-color: #d03050;
}

.flow-node.run-running {
  border-color: #2080f0;
  box-shadow: 0 0 0 3px rgba(32, 128, 240, 0.18), 0 2px 6px rgba(0, 0, 0, 0.08);
}

.run-spin {
  flex: none;
}

.flow-node.executing {
  border-style: dashed;
}

.flow-node-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 8px 0 12px;
  box-sizing: border-box;
}

.icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  color: #fff;
  background: var(--accent);
}

.name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.number {
  flex: none;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 10px;
  opacity: 0.4;
}

.badge,
.run-mark {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 700;
  font-size: 11px;
}

.badge.error,
.run-mark.error {
  background: #d03050;
}

.badge.warning {
  background: #d08a00;
}

.run-mark.ok {
  background: #18a058;
}

.run-step {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-right: -2px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
}

.flow-node:hover .run-step,
.flow-node.selected .run-step,
.flow-node.executing .run-step {
  opacity: 0.7;
}

.run-step:hover:not(:disabled) {
  opacity: 1;
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent-fg);
}

.run-step:disabled {
  cursor: default;
}

.unknown {
  padding: 0 12px 10px;
  color: #d03050;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 10px 10px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 2px 8px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.1);
  min-width: 0;
}

.row-label {
  flex: none;
  max-width: 45%;
  font-size: 11px;
  opacity: 0.55;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-value {
  flex: 1;
  min-width: 0;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.var-chip {
  flex: 1;
  min-width: 0;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 3px;
  overflow: hidden;
  white-space: nowrap;
  color: #2080f0;
}

.var-node {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--flow-node-fg, #222);
  opacity: 0.75;
}

.var-sep {
  opacity: 0.4;
  color: var(--flow-node-fg, #222);
}

.var-x {
  font-size: 10px;
  margin-right: 1px;
}

.branches {
  display: flex;
  flex-direction: column;
  padding: 0 0 8px;
}

.rows + .branches {
  border-top: 1px solid rgba(127, 127, 127, 0.14);
  padding-top: 4px;
}

.branch {
  position: relative;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  height: 22px;
  padding: 0 14px;
}

.branch-name {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.7;
}

/* Handles: small dots on the edge; the header pair sits level with the title. */
.handle {
  width: 10px;
  height: 10px;
  border: 2px solid var(--flow-node-bg, #fff);
  background: #8c8c8c;
  transition: background 0.15s, transform 0.15s;
}

.handle:hover {
  background: var(--accent);
  transform: translateY(-50%) scale(1.3);
}

.head-handle {
  top: 20px;
}
</style>
