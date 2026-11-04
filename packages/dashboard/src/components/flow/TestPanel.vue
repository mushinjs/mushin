<script setup lang="ts">
import { Button, Checkbox, Input, Modal, NumberInput, RadioButton, RadioGroup, Select, Spin, Tag, Toggle, Tooltip, useConfirm, useToast } from '@mushin/ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call, on } from '../../api'
import type { FlowTests, RunTrace, TestAssertion, TestCase, TestCaseInput, TestRunSummary } from '../../types'
import { formatTime } from '../../utils'
import { useFlowEditor } from './context'

type Scope = 'chat' | 'user' | 'flow'

/** A case as the form edits it: lists as lines, values and event data as text. */
interface Draft {
  id?: string
  name: string
  mode: 'message' | 'event' | 'schedule'
  text: string
  userName: string
  private: boolean
  mentioned: boolean
  role: 'user' | 'admin' | 'master'
  groupRole: '' | 'owner' | 'admin' | 'member'
  eventName: string
  eventData: string
  schedule: string
  replies: string
  llmMode: 'mock' | 'real'
  llmReplies: string
  vars: { scope: Scope; name: string; value: string }[]
  expect: TestAssertion[]
}

const props = defineProps<{
  flowId: string
  /** The flow's nodes, for assertions about them. */
  nodes: { value: string; label: string }[]
  /** Exec outputs a node can continue on. */
  execOptions: (nodeId: string) => string[]
  schedules: { id: string; name: string }[]
  /** Saves pending edits, since cases run the saved flow. */
  prepare: () => Promise<void>
}>()
const emit = defineEmits<{
  /** Opens a case's run in the logs. */
  trace: [trace: RunTrace]
  status: [status: { failed: number; total: number }]
}>()
const { t } = useI18n()
const message = useToast()
const dialog = useConfirm()
const editor = useFlowEditor()

const doc = ref<FlowTests>({ cases: [] })
const loading = ref(false)
const running = ref<string | 'all'>()
const generating = ref(false)
const saving = ref(false)
/** Runs from this session, by case id; saved results carry no trace. */
const traces = ref(new Map<string, RunTrace>())
const selectedId = ref<string>()
const draft = ref<Draft>()
const coverage = ref(false)

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)
const valueText = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))
function parseValue(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function toDraft(item?: TestCaseInput & { id?: string }): Draft {
  const input = item?.input ?? {}
  return {
    id: item?.id,
    name: item?.name ?? '',
    mode: input.event ? 'event' : input.schedule ? 'schedule' : 'message',
    text: input.text ?? '',
    userName: input.userName ?? '',
    private: !!input.private,
    mentioned: !!input.mentioned,
    role: input.role ?? 'user',
    groupRole: input.groupRole ?? '',
    eventName: input.event?.name ?? '',
    eventData: JSON.stringify(input.event?.data ?? {}, null, 2),
    schedule: input.schedule ?? '',
    replies: (item?.replies ?? []).join('\n'),
    llmMode: item?.llm.mode ?? 'mock',
    llmReplies: (item?.llm.replies ?? []).join('\n'),
    vars: (item?.vars ?? []).map((entry) => ({ scope: entry.scope, name: entry.name, value: valueText(entry.value) })),
    expect: clone(item?.expect ?? [{ kind: 'noError' }]),
  }
}

/** The case the form describes; throws when the event data is not a JSON object. */
function fromDraft(value: Draft): TestCaseInput {
  let input: TestCaseInput['input']
  if (value.mode === 'event') {
    let data: unknown
    try {
      data = JSON.parse(value.eventData || '{}')
    } catch {}
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(t('flows.testEventInvalid'))
    input = { event: { name: value.eventName.trim(), data: data as Record<string, any> }, ...(value.userName ? { userName: value.userName } : {}) }
  } else if (value.mode === 'schedule') {
    input = { schedule: value.schedule }
  } else {
    input = {
      text: value.text,
      ...(value.userName ? { userName: value.userName } : {}),
      ...(value.private ? { private: true } : {}),
      ...(value.mentioned ? { mentioned: true } : {}),
      ...(value.role !== 'user' ? { role: value.role } : {}),
      ...(value.groupRole && !value.private ? { groupRole: value.groupRole } : {}),
    }
  }
  return {
    name: value.name.trim() || t('flowTests.untitled'),
    input,
    replies: lines(value.replies),
    vars: value.vars.filter((entry) => entry.name.trim()).map((entry) => ({ scope: entry.scope, name: entry.name.trim(), value: parseValue(entry.value) })),
    llm: { mode: value.llmMode, replies: lines(value.llmReplies) },
    expect: value.expect,
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

const selected = computed(() => doc.value.cases.find((item) => item.id === selectedId.value))
const result = (id: string) => doc.value.lastRun?.results.find((item) => item.id === id)
const selectedResult = computed(() => (selectedId.value ? result(selectedId.value) : undefined))

/** Whether the form differs from the saved case. */
const changed = computed(() => {
  if (!draft.value) return false
  if (!draft.value.id) return true
  try {
    return JSON.stringify(fromDraft(draft.value)) !== JSON.stringify(fromDraft(toDraft(selected.value)))
  } catch {
    return true
  }
})

function select(id: string | undefined) {
  selectedId.value = id
  const item = doc.value.cases.find((entry) => entry.id === id)
  draft.value = item ? toDraft(item) : undefined
}

function emitStatus() {
  const total = doc.value.cases.length
  const failed = doc.value.lastRun?.results.filter((item) => !item.passed && doc.value.cases.some((entry) => entry.id === item.id)).length ?? 0
  emit('status', { failed, total })
}

async function load() {
  loading.value = true
  try {
    doc.value = await call<FlowTests>('flows.tests.list', { id: props.flowId })
    traces.value = new Map()
    if (!doc.value.cases.some((item) => item.id === selectedId.value)) select(doc.value.cases[0]?.id)
    else select(selectedId.value)
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
    emitStatus()
  }
}
watch(() => props.flowId, load, { immediate: true })

const off = on('flows/tests', (summary: TestRunSummary) => {
  if (summary.flowId !== props.flowId) return
  doc.value = { ...doc.value, lastRun: summary }
  emitStatus()
})
onBeforeUnmount(off)

// Uncovered nodes are marked on the canvas while the switch is on.
watch([coverage, () => doc.value.lastRun?.uncovered], ([on, ids]) => {
  editor.uncovered.value = new Set(on ? ids ?? [] : [])
}, { immediate: true })
onBeforeUnmount(() => {
  editor.uncovered.value = new Set()
})

async function run(ids?: string[]) {
  if (running.value) return
  running.value = ids?.length === 1 ? ids[0] : 'all'
  try {
    await props.prepare()
    const summary = await call<TestRunSummary>('flows.tests.run', { id: props.flowId, ...(ids ? { cases: ids } : {}) })
    const next = new Map(traces.value)
    for (const item of summary.results) if (item.trace) next.set(item.id, item.trace)
    traces.value = next
    const fresh = new Map(summary.results.map(({ trace: _trace, ...rest }) => [rest.id, rest]))
    const kept = (doc.value.lastRun?.results ?? []).filter((item) => !fresh.has(item.id))
    doc.value = { ...doc.value, lastRun: { ...summary, results: [...kept, ...fresh.values()] } }
    emitStatus()
    if (summary.failed) message.warning(t('flowTests.someFailed', { failed: summary.failed, total: summary.failed + summary.passed }))
    else message.success(t('flowTests.allPassed', { total: summary.passed }))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    running.value = undefined
  }
}

function startNew() {
  selectedId.value = undefined
  draft.value = toDraft()
}

async function save() {
  if (!draft.value) return
  let input: TestCaseInput
  try {
    input = fromDraft(draft.value)
  } catch (error) {
    message.error((error as Error).message)
    return
  }
  saving.value = true
  try {
    if (draft.value.id) {
      const item = await call<TestCase>('flows.tests.update', { id: props.flowId, case: draft.value.id, patch: input })
      doc.value.cases = doc.value.cases.map((entry) => (entry.id === item.id ? item : entry))
      select(item.id)
    } else {
      const item = await call<TestCase>('flows.tests.create', { id: props.flowId, case: input })
      doc.value.cases = [...doc.value.cases, item]
      select(item.id)
    }
    emitStatus()
    message.success(t('flowTests.saved'))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

function askRemove() {
  dialog.warning({ content: t('flowTests.deleteConfirm'), positiveText: t('flowTests.delete'), negativeText: t('common.cancel'), onPositiveClick: remove })
}

async function remove() {
  const id = draft.value?.id
  if (!id) {
    select(doc.value.cases[0]?.id)
    return
  }
  try {
    await call('flows.tests.delete', { id: props.flowId, case: id })
    doc.value.cases = doc.value.cases.filter((entry) => entry.id !== id)
    if (doc.value.lastRun) doc.value.lastRun = { ...doc.value.lastRun, results: doc.value.lastRun.results.filter((entry) => entry.id !== id) }
    select(doc.value.cases[0]?.id)
    emitStatus()
  } catch (error) {
    message.error((error as Error).message)
  }
}

async function setAutoRun(value: boolean) {
  try {
    await call('flows.tests.autoRun', { id: props.flowId, autoRun: value })
    doc.value = { ...doc.value, autoRun: value }
  } catch (error) {
    message.error((error as Error).message)
  }
}

// ---- generating ----

const drafts = ref<(TestCaseInput & { path: string[] })[]>()
const picked = ref<number[]>([])
const draftUncovered = ref<string[]>([])

async function generate() {
  generating.value = true
  try {
    await props.prepare()
    const output = await call<{ drafts: (TestCaseInput & { path: string[] })[]; uncovered: string[] }>('flows.tests.generate', { id: props.flowId })
    if (!output.drafts.length) {
      message.info(t('flowTests.generateNone'))
      return
    }
    drafts.value = output.drafts
    picked.value = output.drafts.map((_, index) => index)
    draftUncovered.value = output.uncovered
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    generating.value = false
  }
}

async function savePicked() {
  if (!drafts.value) return
  saving.value = true
  try {
    for (const index of picked.value) {
      const { path: _path, ...input } = drafts.value[index]
      const item = await call<TestCase>('flows.tests.create', { id: props.flowId, case: input })
      doc.value.cases = [...doc.value.cases, item]
    }
    message.success(t('flowTests.generatedSaved', picked.value.length))
    drafts.value = undefined
    select(doc.value.cases[doc.value.cases.length - 1]?.id)
    emitStatus()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

function togglePick(index: number, value: boolean) {
  picked.value = value ? [...picked.value, index].sort((a, b) => a - b) : picked.value.filter((item) => item !== index)
}

// ---- assertions ----

const KINDS: TestAssertion['kind'][] = ['reply', 'noReply', 'matched', 'visits', 'branch', 'variable', 'call', 'noError', 'judge']
const kindOptions = computed(() => KINDS.map((kind) => ({ value: kind, label: t(`flowTests.kind.${kind}`) })))
const scopeOptions = computed(() => (['chat', 'user', 'flow'] as const).map((scope) => ({ value: scope, label: t(`flowTests.scope.${scope}`) })))
const matchOptions = computed(() => (['equals', 'contains', 'regex'] as const).map((match) => ({ value: match, label: t(`flowTests.match.${match}`) })))
const scheduleOptions = computed(() => props.schedules.map((item) => ({ label: item.name, value: item.id })))
const execSelect = (nodeId: string) => props.execOptions(nodeId).map((name) => ({ label: name, value: name }))

function blank(kind: TestAssertion['kind']): TestAssertion {
  switch (kind) {
    case 'reply': return { kind, match: 'contains', value: '' }
    case 'matched': return { kind, value: true }
    case 'visits': return { kind, node: props.nodes[0]?.value ?? '' }
    case 'branch': return { kind, node: '', exec: '' }
    case 'variable': return { kind, scope: 'chat', name: '', value: '' }
    case 'call': return { kind, action: '' }
    case 'judge': return { kind, criterion: '' }
    default: return { kind }
  }
}

function setKind(index: number, kind: TestAssertion['kind']) {
  draft.value!.expect[index] = blank(kind)
}

const nodeLabel = (id: string) => props.nodes.find((item) => item.value === id)?.label ?? id

/** One line about an assertion, for lists and failures. */
function describe(assertion: TestAssertion | undefined) {
  if (!assertion) return ''
  switch (assertion.kind) {
    case 'reply': return t(`flowTests.say.reply.${assertion.match}`, { value: assertion.value, n: assertion.index === undefined ? t('flowTests.anyReply') : t('flowTests.nthReply', { n: assertion.index + 1 }) })
    case 'matched': return t(assertion.value ? 'flowTests.say.matched' : 'flowTests.say.notMatched')
    case 'visits': return t(assertion.not ? 'flowTests.say.skips' : 'flowTests.say.visits', { node: nodeLabel(assertion.node) })
    case 'branch': return t('flowTests.say.branch', { node: nodeLabel(assertion.node), exec: assertion.exec })
    case 'variable': return t('flowTests.say.variable', { scope: t(`flowTests.scope.${assertion.scope}`), name: assertion.name, value: assertion.value })
    case 'call': return t(assertion.not ? 'flowTests.say.noCall' : 'flowTests.say.call', { action: assertion.action })
    case 'judge': return t('flowTests.say.judge', { criterion: assertion.criterion })
    default: return t(`flowTests.kind.${assertion.kind}`)
  }
}

function caseState(id: string) {
  const item = result(id)
  return item ? (item.passed ? 'passed' : 'failed') : 'none'
}

const uncoveredCount = computed(() => doc.value.lastRun?.uncovered.length ?? 0)

function openTrace() {
  const trace = selectedId.value ? traces.value.get(selectedId.value) : undefined
  if (trace) emit('trace', trace)
}

defineExpose({ run, reload: load })
</script>

<template>
  <div class="tests">
    <div class="cases">
      <div class="cases-bar">
        <Button size="tiny" type="primary" :disabled="!doc.cases.length" :loading="running === 'all'" icon="i-lucide-play" @click="run()">
          {{ t('flowTests.runAll') }}
        </Button>
        <Tooltip>
          <template #trigger>
            <Button size="tiny" :loading="generating" icon="i-lucide-sparkles" @click="generate">
              {{ t('flowTests.generate') }}
            </Button>
          </template>
          {{ t('flowTests.generateHint') }}
        </Tooltip>
        <Button size="tiny" quaternary :aria-label="t('flowTests.add')" icon="i-lucide-plus" @click="startNew" />
      </div>
      <div class="cases-options">
        <div class="option">
          <Toggle size="small" :value="!!doc.autoRun" @update:value="setAutoRun" />
          <span @click="setAutoRun(!doc.autoRun)">{{ t('flowTests.autoRun') }}</span>
        </div>
        <div v-if="doc.lastRun" class="option">
          <Toggle v-model:value="coverage" size="small" />
          <span @click="coverage = !coverage">{{ t('flowTests.coverage', { n: uncoveredCount }) }}</span>
        </div>
      </div>
      <p v-if="doc.lastRun" class="muted small last-run">
        {{ t('flowTests.lastRun', { time: formatTime(doc.lastRun.at), passed: doc.lastRun.passed, failed: doc.lastRun.failed }) }}
      </p>
      <Spin v-if="loading" size="small" class="center" />
      <p v-else-if="!doc.cases.length && !draft" class="muted small empty">{{ t('flowTests.empty') }}</p>
      <div
        v-for="item in doc.cases"
        :key="item.id"
        class="case"
        :class="{ active: item.id === selectedId, [caseState(item.id)]: true }"
        role="button"
        tabindex="0"
        @click="select(item.id)"
        @keyup.enter="select(item.id)"
      >
        <span class="case-mark text-[14px]" :class="caseState(item.id) === 'passed' ? 'i-lucide-circle-check' : caseState(item.id) === 'failed' ? 'i-lucide-circle-x' : 'i-lucide-circle'" />
        <span class="case-name" :title="item.name">{{ item.name }}</span>
        <Button size="tiny" quaternary circle class="case-run" :loading="running === item.id" :aria-label="t('flowTests.runOne')" icon="i-lucide-play" @click.stop="run([item.id])" />
      </div>
      <div v-if="draft && !draft.id" class="case active none">
        <span class="i-lucide-circle case-mark text-[14px]" />
        <span class="case-name">{{ draft.name || t('flowTests.newCase') }}</span>
      </div>
    </div>

    <div class="detail">
      <p v-if="!draft" class="muted empty-detail">
        <span class="i-lucide-flask-conical text-[22px]" /><br>
        {{ t('flowTests.pick') }}
      </p>
      <template v-else>
        <div class="detail-head">
          <Input v-model:value="draft.name" size="small" class="name-input" :placeholder="t('flowTests.namePlaceholder')" />
          <Tag v-if="draft.id && selectedResult" size="small" :type="selectedResult.passed ? 'success' : 'error'">
            {{ selectedResult.passed ? t('flowTests.passed') : t('flowTests.failed') }} · {{ selectedResult.ms }} ms
          </Tag>
          <span class="spacer" />
          <Button v-if="draft.id && traces.get(draft.id)" size="small" quaternary icon="i-lucide-eye" @click="openTrace">
            {{ t('flowTests.showTrace') }}
          </Button>
          <Button v-if="draft.id" size="small" :loading="running === draft.id" :disabled="changed" icon="i-lucide-play" @click="run([draft.id])">
            {{ t('flowTests.runOne') }}
          </Button>
          <Button size="small" type="primary" :disabled="!changed" :loading="saving" icon="i-lucide-save" @click="save">
            {{ t('flowTests.save') }}
          </Button>
          <Tooltip v-if="draft.id">
            <template #trigger>
              <Button size="small" quaternary :aria-label="t('flowTests.delete')" icon="i-lucide-trash-2" @click="askRemove" />
            </template>
            {{ t('flowTests.delete') }}
          </Tooltip>
          <Button v-else size="small" quaternary @click="remove">{{ t('flowTests.cancel') }}</Button>
        </div>

        <div v-if="draft.id && selectedResult?.failures.length" class="failures">
          <div v-for="item in selectedResult.failures" :key="item.index" class="failure">
            <strong>{{ describe(selected?.expect[item.index]) }}</strong>
            <span>{{ item.message }}</span>
          </div>
        </div>

        <section class="block">
          <div class="block-title">{{ t('flowTests.input') }}</div>
          <div class="row">
            <RadioGroup v-model:value="draft.mode" size="small">
              <RadioButton value="message">{{ t('flows.testModeMessage') }}</RadioButton>
              <RadioButton value="event">{{ t('flows.testModeEvent') }}</RadioButton>
              <RadioButton value="schedule">{{ t('flows.testModeSchedule') }}</RadioButton>
            </RadioGroup>
          </div>
          <template v-if="draft.mode === 'message'">
            <div class="row">
              <Input v-model:value="draft.text" size="small" class="grow" :placeholder="t('flows.testPlaceholder')" />
              <Input v-model:value="draft.userName" size="small" class="short" :placeholder="`${t('flows.testUser')}: Tester`" />
            </div>
            <div class="row">
              <Checkbox v-model:checked="draft.private" size="small">{{ t('flows.testPrivate') }}</Checkbox>
              <Checkbox v-model:checked="draft.mentioned" size="small">{{ t('flows.testMentioned') }}</Checkbox>
              <RadioGroup v-model:value="draft.role" size="small">
                <RadioButton value="user">{{ t('flows.roleUser') }}</RadioButton>
                <RadioButton value="admin">{{ t('flows.roleAdmin') }}</RadioButton>
                <RadioButton value="master">{{ t('flows.roleMaster') }}</RadioButton>
              </RadioGroup>
              <RadioGroup v-if="!draft.private" v-model:value="draft.groupRole" size="small">
                <RadioButton value="">{{ t('flows.groupRoleNone') }}</RadioButton>
                <RadioButton value="member">{{ t('flows.groupRoleMember') }}</RadioButton>
                <RadioButton value="admin">{{ t('flows.groupRoleAdmin') }}</RadioButton>
                <RadioButton value="owner">{{ t('flows.groupRoleOwner') }}</RadioButton>
              </RadioGroup>
            </div>
          </template>
          <template v-else-if="draft.mode === 'event'">
            <div class="row">
              <Input v-model:value="draft.eventName" size="small" class="short" :placeholder="t('flows.testEvent')" />
            </div>
            <Input v-model:value="draft.eventData" type="textarea" size="small" class="mono" :autosize="{ minRows: 2, maxRows: 6 }" />
          </template>
          <div v-else class="row">
            <Select
              v-model:value="draft.schedule"
              size="small"
              class="short"
              :options="scheduleOptions"
              :placeholder="schedules.length ? t('flows.testSchedule') : t('flows.testNoSchedule')"
            />
          </div>
          <div class="row top">
            <div class="grow">
              <div class="label">{{ t('flowTests.replies') }}</div>
              <Input v-model:value="draft.replies" type="textarea" size="small" :autosize="{ minRows: 1, maxRows: 4 }" :placeholder="t('flowTests.repliesPlaceholder')" />
            </div>
            <div class="grow">
              <div class="label">
                {{ t('flowTests.llm') }}
                <RadioGroup v-model:value="draft.llmMode" size="small" class="inline">
                  <RadioButton value="mock">{{ t('flowTests.llmMock') }}</RadioButton>
                  <RadioButton value="real">{{ t('flowTests.llmReal') }}</RadioButton>
                </RadioGroup>
              </div>
              <Input
                v-model:value="draft.llmReplies"
                type="textarea"
                size="small"
                :disabled="draft.llmMode === 'real'"
                :autosize="{ minRows: 1, maxRows: 4 }"
                :placeholder="t('flowTests.llmPlaceholder')"
              />
            </div>
          </div>
        </section>

        <section class="block">
          <div class="block-title">
            {{ t('flowTests.vars') }}
            <Button size="tiny" quaternary icon="i-lucide-plus" @click="draft.vars.push({ scope: 'chat', name: '', value: '' })" />
          </div>
          <p v-if="!draft.vars.length" class="muted small">{{ t('flowTests.varsEmpty') }}</p>
          <div v-for="(entry, index) in draft.vars" :key="index" class="row">
            <Select v-model:value="entry.scope" size="small" class="scope" :options="scopeOptions" />
            <Input v-model:value="entry.name" size="small" class="short" :placeholder="t('flowTests.varName')" />
            <Input v-model:value="entry.value" size="small" class="grow" :placeholder="t('flowTests.varValue')" />
            <Button size="small" quaternary circle :aria-label="t('flowTests.delete')" icon="i-lucide-trash-2" @click="draft.vars.splice(index, 1)" />
          </div>
        </section>

        <section class="block">
          <div class="block-title">
            {{ t('flowTests.expect') }}
            <Button size="tiny" quaternary icon="i-lucide-plus" @click="draft.expect.push(blank('reply'))" />
          </div>
          <p v-if="!draft.expect.length" class="muted small">{{ t('flowTests.expectEmpty') }}</p>
          <div
            v-for="(item, index) in draft.expect"
            :key="index"
            class="row assertion"
            :class="{ failing: !!selectedResult?.failures.some((entry) => entry.index === index) && !changed }"
          >
            <Select :value="item.kind" size="small" class="kind" :options="kindOptions" @update:value="(kind: TestAssertion['kind']) => setKind(index, kind)" />
            <template v-if="item.kind === 'reply'">
              <Select v-model:value="item.match" size="small" class="match" :options="matchOptions" />
              <Input v-model:value="item.value" size="small" class="grow" :placeholder="t('flowTests.replyValue')" />
              <NumberInput
                :value="item.index === undefined ? null : item.index + 1"
                size="small"
                class="index"
                :min="1"
                clearable
                :placeholder="t('flowTests.anyReply')"
                @update:value="(value: number | null) => (item.index = value ? value - 1 : undefined)"
              />
            </template>
            <Toggle v-else-if="item.kind === 'matched'" v-model:value="item.value" size="small" />
            <template v-else-if="item.kind === 'visits'">
              <Select v-model:value="item.node" size="small" class="grow" filterable :options="nodes" />
              <Checkbox :checked="!!item.not" size="small" @update:checked="(value: boolean) => (item.not = value || undefined)">{{ t('flowTests.not') }}</Checkbox>
            </template>
            <template v-else-if="item.kind === 'branch'">
              <Select v-model:value="item.node" size="small" class="grow" filterable :options="nodes" />
              <Select v-model:value="item.exec" size="small" class="match" filterable tag :options="execSelect(item.node)" :placeholder="t('flowTests.exec')" />
            </template>
            <template v-else-if="item.kind === 'variable'">
              <Select v-model:value="item.scope" size="small" class="scope" :options="scopeOptions" />
              <Input v-model:value="item.name" size="small" class="short" :placeholder="t('flowTests.varName')" />
              <Input v-model:value="item.value" size="small" class="grow" :placeholder="t('flowTests.varValue')" />
            </template>
            <template v-else-if="item.kind === 'call'">
              <Input v-model:value="item.action" size="small" class="grow" placeholder="set_group_ban" />
              <Checkbox :checked="!!item.not" size="small" @update:checked="(value: boolean) => (item.not = value || undefined)">{{ t('flowTests.not') }}</Checkbox>
            </template>
            <Input v-else-if="item.kind === 'judge'" v-model:value="item.criterion" size="small" class="grow" :placeholder="t('flowTests.judgePlaceholder')" />
            <span v-else class="grow" />
            <Button size="small" quaternary circle :aria-label="t('flowTests.delete')" icon="i-lucide-trash-2" @click="draft.expect.splice(index, 1)" />
          </div>
        </section>
      </template>
    </div>

    <Modal :show="!!drafts" class="drafts-modal" :title="t('flowTests.generateTitle')" @update:show="(value: boolean) => !value && (drafts = undefined)">
      <p class="muted small">{{ t('flowTests.generateIntro', { n: drafts?.length ?? 0 }) }}</p>
      <div class="drafts">
        <label v-for="(item, index) in drafts" :key="index" class="draft">
          <Checkbox :checked="picked.includes(index)" @update:checked="(value: boolean) => togglePick(index, value)" />
          <div class="draft-body">
            <div class="draft-name">{{ item.name }}</div>
            <div class="draft-expect">
              <Tag v-for="(assertion, position) in item.expect" :key="position" size="tiny">{{ describe(assertion) }}</Tag>
            </div>
          </div>
        </label>
      </div>
      <p v-if="draftUncovered.length" class="muted small">
        {{ t('flowTests.generateUncovered', { nodes: draftUncovered.map(nodeLabel).join('、') }) }}
      </p>
      <template #footer>
        <div class="modal-foot">
          <Button @click="drafts = undefined">{{ t('flowTests.cancel') }}</Button>
          <Button type="primary" :disabled="!picked.length" :loading="saving" @click="savePicked">
            {{ t('flowTests.savePicked', { n: picked.length }) }}
          </Button>
        </div>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.tests {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.cases {
  width: 260px;
  flex: none;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 8px;
  border-right: 1px solid rgba(127, 127, 127, 0.14);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cases-bar {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cases-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 2px 2px;
}

.option {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.option span {
  cursor: pointer;
}

.last-run {
  margin: 4px 2px;
}

.center {
  margin: 12px auto;
}

.empty {
  margin: 8px 2px;
}

.case {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px 3px 6px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}

.case:hover {
  background: rgba(127, 127, 127, 0.08);
}

.case.active {
  background: rgba(127, 127, 127, 0.16);
}

.case-mark {
  flex: none;
  opacity: 0.5;
}

.case.passed .case-mark {
  color: var(--ok);
  opacity: 1;
}

.case.failed .case-mark {
  color: var(--bad);
  opacity: 1;
}

.case-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.case-run {
  opacity: 0;
}

.case:hover .case-run,
.case.active .case-run {
  opacity: 1;
}

.detail {
  flex: 1;
  min-width: 0;
  overflow: auto;
  scrollbar-gutter: stable;
  padding: 8px 12px 12px;
}

.empty-detail {
  text-align: center;
  margin-top: 40px;
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.name-input {
  flex: 0 1 320px;
  min-width: 160px;
}

.spacer {
  flex: 1;
}

.failures {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}

.failure {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  color: var(--bad);
  background: rgba(208, 48, 80, 0.1);
  white-space: pre-wrap;
  word-break: break-word;
}

.block {
  margin-bottom: 10px;
}

.block-title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  opacity: 0.75;
  margin-bottom: 6px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.row.top {
  align-items: flex-start;
}

.grow {
  flex: 1 1 180px;
  min-width: 0;
}

.short {
  flex: 0 1 180px;
  min-width: 100px;
}

.scope {
  width: 96px;
}

.kind {
  width: 140px;
}

.match {
  width: 120px;
}

.index {
  width: 110px;
}

.label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  opacity: 0.8;
  margin-bottom: 4px;
}

.assertion {
  padding: 2px 4px;
  margin-left: -4px;
  border-radius: 6px;
}

.assertion.failing {
  background: rgba(208, 48, 80, 0.1);
}

.mono :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.drafts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 50vh;
  overflow-y: auto;
  margin: 8px 0;
}

.draft {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.08);
  cursor: pointer;
}

.draft-body {
  min-width: 0;
}

.draft-name {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 4px;
}

.draft-expect {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.muted {
  opacity: 0.65;
  font-size: 13px;
}

.small {
  font-size: 12px;
}

@media (max-width: 760px) {
  .cases {
    width: 170px;
  }
}
</style>

<style>
.drafts-modal {
  width: min(640px, calc(100vw - 32px));
}
</style>
