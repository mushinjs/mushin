<script setup lang="ts">
import { Button, Checkbox, Input, Popover, RadioButton, RadioGroup, Select, Tag } from '@mushinjs/ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { categoryColors, eventSamples } from '../../flow'
import type { RunTrace, Segment, TestOption, TraceStep } from '../../types'
import { formatTime, localize, pretty, segmentsText } from '../../utils'
import { useFlowEditor } from './context'
import { nodeIcon } from './icons'

export interface TestInput {
  text: string
  /** Run the editor's sample message instead of the text, while one is picked. */
  useSample: boolean
  userName: string
  /** The sender's id and group; empty uses the test defaults. */
  userId: string
  groupId: string
  private: boolean
  mentioned: boolean
  /** Pretended role on the bot and in the group. */
  role: 'user' | 'admin' | 'master'
  groupRole: '' | 'owner' | 'admin' | 'member'
  /** What starts the test run. */
  mode: 'message' | 'event' | 'schedule'
  eventName: string
  /** The event as JSON text, edited by hand. */
  eventData: string
  /** Id of the schedule trigger to fire. */
  schedule: string
  /** Answers for "wait for reply", one per line. */
  replies: string
}

const props = defineProps<{
  runs: RunTrace[]
  testing: boolean
  /** Schedule triggers in the flow, for schedule test runs. */
  schedules: { id: string; name: string }[]
  nodeName: (id: string) => string
  nodeType: (id: string) => string | undefined
  /** Test cases of the flow and how many failed last time, for the tests tab. */
  tests?: { failed: number; total: number }
  /** Runs still going on, by id: their trace is only what happened so far. */
  live?: string[]
  /** Test runs the flow's nodes call for, offered as one-click choices. */
  quick?: TestOption[]
  /** The editor's sample message, shown in place of the text box when runs use it. */
  sample?: { text: string; user: string }
}>()
const emit = defineEmits<{ run: []; clear: []; show: [trace: RunTrace]; select: [nodeId: string] }>()
const test = defineModel<TestInput>('test', { required: true })
const open = defineModel<boolean>('open', { required: true })
/** Which tab the panel shows: run logs, or the flow's test cases (the `tests` slot). */
const tab = defineModel<'logs' | 'tests'>('tab', { default: 'logs' })
const { t, locale } = useI18n()
const editor = useFlowEditor()

/** Fills the test settings from a quick choice: everything it does not set goes back to the defaults. */
function applyQuick(option: TestOption) {
  const input = option.input
  test.value = {
    ...test.value,
    mode: 'message',
    ...(input.text !== undefined ? { text: input.text } : {}),
    userId: input.userId ?? '',
    userName: input.userName ?? '',
    groupId: input.groupId ?? '',
    private: !!input.private,
    mentioned: !!input.mentioned,
    role: input.role ?? 'user',
    groupRole: input.groupRole ?? '',
  }
}
const quickKey = (option: TestOption) => JSON.stringify(option.input)
const quickActive = (option: TestOption) => {
  const input = option.input
  return (input.text === undefined || input.text === test.value.text)
    && (input.userId ?? '') === test.value.userId && (input.groupId ?? '') === test.value.groupId
    && (input.role ?? 'user') === test.value.role && (input.groupRole ?? '') === test.value.groupRole && !!input.private === test.value.private
}

/** The run shown; the editor uses it for the node cards' hover. */
const runId = defineModel<string>('current')
const stepIndex = ref(0)
const side = ref<'input' | 'output'>('output')
const view = ref<'table' | 'json'>('table')
const input = ref<InstanceType<typeof Input>>()

const run = computed(() => props.runs.find((item) => item.id === runId.value) ?? props.runs[0])
const step = computed<TraceStep | undefined>(() => run.value?.steps[stepIndex.value])
const total = (trace: RunTrace) => trace.steps.reduce((sum, item) => sum + item.ms, 0)

const runOptions = computed(() => props.runs.map((trace) => ({
  value: trace.id,
  label: `${formatTime(trace.at)} · ${trace.test ? t('flows.runKindTest') : t('flows.runLive')} · ${trace.text}`,
})))

function status(trace: RunTrace) {
  if (props.live?.includes(trace.id)) return { type: 'success' as const, text: t('runs.status.running') }
  if (trace.error) return { type: 'error' as const, text: t('flows.runFailed') }
  if (!trace.steps.length) return { type: 'default' as const, text: t('flows.logsNoMatch') }
  return { type: 'success' as const, text: t('flows.logsSuccessIn', { ms: total(trace) }) }
}

function pickStep(trace: RunTrace | undefined) {
  if (!trace) return
  const stop = trace.stopAt ? trace.steps.findIndex((item) => item.nodeId === trace.stopAt) : -1
  const failed = trace.steps.findIndex((item) => item.error)
  stepIndex.value = failed >= 0 ? failed : stop >= 0 ? stop : Math.max(0, trace.steps.length - 1)
}

/** Shows a run, opening the panel; called after a test or a single-step run. */
function focus(id: string) {
  runId.value = id
  open.value = true
  tab.value = 'logs'
  side.value = 'output'
  pickStep(props.runs.find((item) => item.id === id))
}

function pickTab(value: 'logs' | 'tests') {
  tab.value = value
  open.value = true
}

function selectRun(id: string) {
  runId.value = id
  pickStep(run.value)
  if (run.value) emit('show', run.value)
}

function selectStep(index: number) {
  stepIndex.value = index
  const nodeId = run.value?.steps[index]?.nodeId
  if (nodeId) emit('select', nodeId)
}

/** Selecting a node on the canvas shows its step in the current run, if it ran. */
function showNode(nodeId: string | undefined) {
  const index = run.value?.steps.findIndex((item) => item.nodeId === nodeId) ?? -1
  if (index >= 0) stepIndex.value = index
}

const eventOptions = Object.keys(eventSamples).map((name) => ({ label: name, value: name }))
const scheduleOptions = computed(() => props.schedules.map((item) => ({ label: item.name, value: item.id })))

function pickEvent(name: string) {
  test.value.eventName = name
  test.value.eventData = JSON.stringify(eventSamples[name] ?? {}, null, 2)
}

/** Whether the test has what its mode needs. */
const ready = computed(() => {
  if (test.value.mode === 'event') return !!test.value.eventName.trim()
  if (test.value.mode === 'schedule') return !!test.value.schedule
  if (props.sample && test.value.useSample) return true
  return !!test.value.text.trim()
})

function focusInput() {
  open.value = true
  tab.value = 'logs'
  input.value?.focus()
}

defineExpose({ focus, showNode, focusInput })

watch(() => props.runs[0]?.id, (id, previous) => {
  if (!runId.value || runId.value === previous) {
    runId.value = id
    pickStep(run.value)
  }
})

const values = computed(() => (side.value === 'input' ? step.value?.inputs : step.value?.outputs))
const columns = computed(() => Object.keys(values.value ?? {}))

const isSegments = (value: unknown): value is Segment[] => Array.isArray(value) && value.every((item) => item && typeof item === 'object' && 'type' in item && 'data' in item)
function cell(value: unknown) {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (isSegments(value)) return segmentsText(value)
  return JSON.stringify(value)
}
const cellType = (value: unknown) => (value === null || value === undefined ? 'null' : Array.isArray(value) ? 'array' : typeof value)

function accent(nodeId: string) {
  const typeId = props.nodeType(nodeId)
  const info = typeId ? editor.types.value.get(typeId) : undefined
  return info ? categoryColors[info.category] : '#8c8c8c'
}
const iconOf = (nodeId: string) => {
  const typeId = props.nodeType(nodeId) ?? ''
  return nodeIcon(typeId, editor.types.value.get(typeId)?.category)
}
</script>

<template>
  <section class="logs" :class="{ open }">
    <header class="logs-head">
      <button type="button" class="logs-toggle" :aria-label="open ? t('flowTests.collapse') : t('flowTests.expand')" @click="open = !open">
        <span :class="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'" :style="{ fontSize: '14px' }" />
      </button>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" class="tab" :class="{ active: tab === 'logs' }" :aria-selected="tab === 'logs'" @click="pickTab('logs')">
          <span class="logs-title">{{ t('flows.logs') }}</span>
          <Tag v-if="run && tab === 'logs'" size="tiny" :type="status(run).type">{{ status(run).text }}</Tag>
        </button>
        <button type="button" role="tab" class="tab" :class="{ active: tab === 'tests' }" :aria-selected="tab === 'tests'" data-agent-target="flows.tests" @click="pickTab('tests')">
          <span class="logs-title">{{ t('flowTests.tab') }}</span>
          <Tag v-if="tests?.total" size="tiny" :type="tests.failed ? 'error' : 'default'">
            {{ tests.failed ? t('flowTests.failedCount', { n: tests.failed }) : tests.total }}
          </Tag>
        </button>
      </div>
      <span class="spacer" />
      <template v-if="tab === 'logs'">
        <div v-if="test.mode === 'message' && sample && test.useSample" class="test-text sample-chip" :title="sample.text">
          <Tag size="small" type="info" closable @close="test.useSample = false">
            {{ t('flows.sampleRun', { user: sample.user }) }}
          </Tag>
          <span class="sample-text">{{ sample.text }}</span>
        </div>
        <Input
          v-else-if="test.mode === 'message'"
          ref="input"
          v-model:value="test.text"
          size="small"
          class="test-text"
          clearable
          :placeholder="t('flows.testPlaceholder')"
          @keyup.enter="emit('run')"
        />
        <Select
          v-else-if="test.mode === 'event'"
          :value="test.eventName || null"
          size="small"
          class="test-text"
          filterable
          tag
          :options="eventOptions"
          :placeholder="t('flows.testEvent')"
          @update:value="pickEvent"
        />
        <Select
          v-else
          v-model:value="test.schedule"
          size="small"
          class="test-text"
          :options="scheduleOptions"
          :placeholder="schedules.length ? t('flows.testSchedule') : t('flows.testNoSchedule')"
        />
        <Popover placement="top" align="end">
          <template #trigger>
            <Button size="small" quaternary circle :aria-label="t('flows.testOptions')" icon="i-lucide-sliders-horizontal" />
          </template>
          <div class="flex flex-col gap-1 test-options">
            <Checkbox v-if="sample" v-model:checked="test.useSample">{{ t('flows.sampleUse') }}</Checkbox>
            <template v-if="quick?.length">
              <span class="muted small">{{ t('flows.testQuick') }}</span>
              <div class="quick">
                <Tag
                  v-for="option in quick"
                  :key="quickKey(option)"
                  size="small"
                  checkable
                  :checked="quickActive(option)"
                  @update:checked="applyQuick(option)"
                >{{ localize(option.label, locale) }}</Tag>
              </div>
            </template>
            <span class="muted small">{{ t('flows.testMode') }}</span>
            <RadioGroup v-model:value="test.mode" size="small">
              <RadioButton value="message">{{ t('flows.testModeMessage') }}</RadioButton>
              <RadioButton value="event">{{ t('flows.testModeEvent') }}</RadioButton>
              <RadioButton value="schedule">{{ t('flows.testModeSchedule') }}</RadioButton>
            </RadioGroup>
            <template v-if="test.mode === 'message'">
              <div class="who">
                <Input v-model:value="test.userName" size="small" :placeholder="`${t('flows.testUser')}: Tester`" />
                <Input v-model:value="test.userId" size="small" :placeholder="`${t('flows.testUserId')}: 10000`" />
                <Input v-if="!test.private" v-model:value="test.groupId" size="small" :placeholder="`${t('flows.testGroupId')}: test`" />
              </div>
              <Checkbox v-model:checked="test.private">{{ t('flows.testPrivate') }}</Checkbox>
              <Checkbox v-model:checked="test.mentioned">{{ t('flows.testMentioned') }}</Checkbox>
              <span class="muted small">{{ t('flows.testRole') }}</span>
              <RadioGroup v-model:value="test.role" size="small">
                <RadioButton value="user">{{ t('flows.roleUser') }}</RadioButton>
                <RadioButton value="admin">{{ t('flows.roleAdmin') }}</RadioButton>
                <RadioButton value="master">{{ t('flows.roleMaster') }}</RadioButton>
              </RadioGroup>
              <RadioGroup v-if="!test.private" v-model:value="test.groupRole" size="small">
                <RadioButton value="">{{ t('flows.groupRoleNone') }}</RadioButton>
                <RadioButton value="member">{{ t('flows.groupRoleMember') }}</RadioButton>
                <RadioButton value="admin">{{ t('flows.groupRoleAdmin') }}</RadioButton>
                <RadioButton value="owner">{{ t('flows.groupRoleOwner') }}</RadioButton>
              </RadioGroup>
            </template>
            <template v-else-if="test.mode === 'event'">
              <span class="muted small">{{ t('flows.testEventData') }}</span>
              <Input v-model:value="test.eventData" type="textarea" size="small" class="mono" :autosize="{ minRows: 4, maxRows: 10 }" />
            </template>
            <span class="muted small">{{ t('flows.testReplyLines') }}</span>
            <Input v-model:value="test.replies" type="textarea" size="small" :autosize="{ minRows: 1, maxRows: 4 }" />
            <span class="muted small">{{ t('flows.testHint') }}</span>
          </div>
        </Popover>
        <Button
          size="small"
          type="primary"
          :loading="testing"
          :disabled="!ready"
          data-agent-target="flows.test"
          @click="emit('run')" icon="i-lucide-play">
          {{ t('flows.runFlow') }}
        </Button>
        <Button size="small" quaternary :disabled="!runs.length" @click="emit('clear')" icon="i-lucide-trash-2">
          <span class="clear-label">{{ t('flows.logsClear') }}</span>
        </Button>
      </template>
    </header>

    <div v-if="open && tab === 'tests'" class="logs-body tests-body">
      <slot name="tests" />
    </div>
    <div v-else-if="open" class="logs-body">
      <p v-if="!run" class="logs-empty muted">{{ t('flows.logsEmpty') }}</p>
      <template v-else>
        <div class="logs-steps">
          <Select :value="run.id" size="small" :options="runOptions" :consistent-menu-width="false" @update:value="selectRun" />
          <p v-if="run.stopAt" class="muted small stop-note">
            {{ run.steps.some((item) => item.nodeId === run!.stopAt) ? t('flows.logsStoppedAt', { node: nodeName(run.stopAt) }) : t('flows.logsNotReached', { node: nodeName(run.stopAt) }) }}
          </p>
          <button
            v-for="(item, index) in run.steps"
            :key="index"
            type="button"
            class="step"
            :class="{ active: index === stepIndex, failed: !!item.error }"
            :style="{ '--accent': accent(item.nodeId) }"
            @click="selectStep(index)"
          >
            <span class="step-icon"><span :class="iconOf(item.nodeId)" :style="{ fontSize: '13px' }" /></span>
            <span class="step-name">{{ nodeName(item.nodeId) }}</span>
            <span v-if="item.exec && item.exec !== 'next'" class="step-exec">{{ item.exec }}</span>
            <span v-if="item.skipped" class="step-ms">{{ t('flows.logsSkipped') }}</span>
            <span v-else class="step-ms">{{ item.ms }} ms</span>
          </button>
          <p v-if="!run.steps.length && !run.error" class="muted small">{{ t('flows.testNoMatch') }}</p>
          <template v-if="run.replies.length">
            <div class="replies-title">{{ t('flows.testReplies') }}</div>
            <div v-for="(reply, index) in run.replies" :key="index" class="reply">{{ reply }}</div>
          </template>
          <template v-if="run.calls?.length">
            <div class="replies-title">{{ run.test ? t('flows.testCalls') : t('flows.testCallsLive') }}</div>
            <div v-for="(item, index) in run.calls" :key="`c${index}`" class="reply call" :class="{ 'is-error': !!item.error }" :title="item.error">
              <code>{{ item.action }}</code> {{ JSON.stringify(item.params) }}
            </div>
          </template>
        </div>

        <div class="logs-detail">
          <div v-if="run.error && !step" class="detail-error">{{ run.error }}</div>
          <template v-if="step">
            <div class="detail-head">
              <span class="step-icon" :style="{ '--accent': accent(step.nodeId) }"><span :class="iconOf(step.nodeId)" :style="{ fontSize: '14px' }" /></span>
              <strong class="detail-name">{{ nodeName(step.nodeId) }}</strong>
              <span class="muted small" :class="{ 'is-error': !!step.error }">
                {{ step.error ? t('flows.runFailed') : t('flows.logsSuccessIn', { ms: step.ms }) }}
              </span>
              <span class="spacer" />
              <RadioGroup v-model:value="view" size="small">
                <RadioButton value="table">{{ t('flows.logsTable') }}</RadioButton>
                <RadioButton value="json">JSON</RadioButton>
              </RadioGroup>
              <RadioGroup v-model:value="side" size="small">
                <RadioButton value="input">{{ t('flows.logsInput') }}</RadioButton>
                <RadioButton value="output">{{ t('flows.logsOutput') }}</RadioButton>
              </RadioGroup>
            </div>
            <div v-if="step.error" class="detail-error">{{ step.error }}</div>
            <div class="detail-label">
              {{ side === 'input' ? t('flows.logsInput') : t('flows.logsOutput') }}
              <span v-if="columns.length" class="muted"> · {{ t('flows.logsFields', columns.length) }}</span>
            </div>
            <p v-if="!columns.length" class="muted small">
              {{ side === 'input' ? t('flows.logsNoInput') : t('flows.logsNoOutput') }}
            </p>
            <div v-else-if="view === 'table'" class="table-wrap">
              <table class="values">
                <thead>
                  <tr><th v-for="key in columns" :key="key">{{ key }}</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td v-for="key in columns" :key="key" :class="`type-${cellType(values![key])}`">{{ cell(values![key]) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <pre v-else class="json">{{ pretty(values) }}</pre>
          </template>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.sample-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}

.sample-text {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.quick {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-width: 340px;
}

.who {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.who > :first-child {
  grid-column: 1 / -1;
}

.logs {
  flex: none;
  display: flex;
  flex-direction: column;
  border-top: 1px solid rgba(127, 127, 127, 0.18);
  background: var(--flow-node-bg);
}

.logs-head {
  display: flex;
  align-items: center;
  /* In a narrow panel the test controls drop to a second line instead of covering the tabs. */
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 10px;
  min-height: 32px;
}

.open .logs-head {
  border-bottom: 1px solid rgba(127, 127, 127, 0.14);
}

.logs-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  min-width: 0;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  /* The tabs keep their width; the test input next to them is what gives way in a narrow panel. */
  flex: none;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  white-space: nowrap;
  padding: 3px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  opacity: 0.6;
}

.tab:hover {
  background: rgba(127, 127, 127, 0.08);
}

.tab.active {
  opacity: 1;
  background: rgba(127, 127, 127, 0.14);
}

.logs-title {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
}

.spacer {
  flex: 1;
}

.test-text {
  width: 260px;
  min-width: 140px;
  flex: 0 1 260px;
}

.test-options {
  width: 220px;
}

.logs-body {
  height: min(240px, 40vh);
  display: flex;
  min-height: 0;
}

.tests-body {
  height: min(340px, 50vh);
}

.logs-empty {
  margin: auto;
  padding: 16px;
  text-align: center;
}

.logs-steps {
  width: 240px;
  flex: none;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 8px;
  border-right: 1px solid rgba(127, 127, 127, 0.14);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stop-note {
  margin: 4px 2px;
}

.step {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.step:first-of-type {
  margin-top: 6px;
}

.step:hover {
  background: rgba(127, 127, 127, 0.08);
}

.step.active {
  background: rgba(127, 127, 127, 0.16);
}

.step.failed .step-name {
  color: var(--bad);
}

.step-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: var(--accent-fg);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}

.step-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step-exec {
  font-size: 11px;
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.14);
  white-space: nowrap;
}

.step-ms {
  font-size: 11px;
  opacity: 0.55;
  white-space: nowrap;
}

.call code {
  font-weight: 600;
}

.mono :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.replies-title {
  margin: 10px 2px 4px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.75;
}

.reply {
  padding: 5px 8px;
  border-radius: 6px;
  background: rgba(32, 128, 240, 0.12);
  white-space: pre-wrap;
  font-size: 12px;
  margin-bottom: 4px;
}

.logs-detail {
  flex: 1;
  min-width: 0;
  overflow: auto;
  scrollbar-gutter: stable;
  padding: 8px 12px 12px;
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.detail-name {
  font-size: 13px;
}

.is-error {
  color: var(--bad);
  opacity: 1;
}

.detail-error {
  color: var(--bad);
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(208, 48, 80, 0.1);
  margin-bottom: 8px;
  white-space: pre-wrap;
}

.detail-label {
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  opacity: 0.7;
  margin-bottom: 6px;
}

.table-wrap {
  overflow-x: auto;
}

.values {
  border-collapse: collapse;
  font-size: 12px;
  min-width: 100%;
}

.values th,
.values td {
  border: 1px solid rgba(127, 127, 127, 0.22);
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
  max-width: 320px;
  white-space: pre-wrap;
  word-break: break-word;
}

.values th {
  font-weight: 600;
  background: rgba(127, 127, 127, 0.08);
  white-space: nowrap;
}

.values td.type-number,
.values td.type-boolean {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  color: var(--primary);
}

.values td.type-object,
.values td.type-array {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}

.json {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.1);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
}

.muted {
  opacity: 0.65;
  font-size: 13px;
}

.small {
  font-size: 12px;
}

@media (max-width: 760px) {
  .logs-head {
    flex-wrap: wrap;
  }

  .clear-label {
    display: none;
  }

  .logs-steps {
    width: 160px;
  }
}
</style>
