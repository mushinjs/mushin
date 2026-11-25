<script setup lang="ts">
import { Button, Spin, Tag, useToast } from '@mushinjs/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { highlight } from '../../highlight'
import { type AskItem, type ChatItem, DELEGATE } from '../../stores/fairy'
import { useDataStore } from '../../stores/data'
import { type PanelView, workspace } from '../../stores/workspace'
import type { FairyTaskReport } from '../../types'
import AskCard from './AskCard.vue'
import { actionLabel, actionTarget, askAnswer } from './records'
import ToolDetail from './ToolDetail.vue'

/**
 * One tool call of a Fairy reply: what it did in words, how it went, and what went in and came out on
 * demand. A task handed to a helper shows as a card: the helper, the task, what it is doing, and its report.
 * A question Fairy waits on (`ask`) shows where it was asked, to be answered there.
 */
const props = defineProps<{ item: Extract<ChatItem, { kind: 'tool' }>; expanded: boolean; ask?: AskItem }>()
const emit = defineEmits<{
  toggle: []
  confirm: [approved: boolean]
  confirmTask: [approved: boolean]
  openTask: [session: string]
  answer: [result: { choice: number } | { other: string }]
}>()

const { t, te } = useI18n()
const data = useDataStore()

const label = computed(() => actionLabel(props.item.action, t, te))
/** The action of an approval a helper waits on, in words. */
const taskConfirmLabel = computed(() => (props.item.task?.confirm ? actionLabel(props.item.task.confirm.action, t, te) : ''))
const stepLabel = (action: string) => actionLabel(action, t, te)

const isTask = computed(() => props.item.action === DELEGATE)
const input = computed(() => (props.item.input ?? {}) as { role?: string; task?: string })
const roleName = computed(() => {
  const role = input.value.role ?? ''
  return te(`fairyTask.roles.${role}`) ? t(`fairyTask.roles.${role}`) : role
})
const report = computed(() => {
  const result = props.item.result as Partial<FairyTaskReport> | undefined
  return result && typeof result === 'object' && typeof result.summary === 'string' ? result as FairyTaskReport : undefined
})
const taskState = computed(() => {
  if (props.item.task?.confirm) return 'confirm'
  if (props.item.state === 'running' || props.item.state === 'confirm') return 'running'
  if (report.value) return report.value.status
  return 'failed'
})
/** The last few things the helper did, newest last. */
const steps = computed(() => props.item.task?.steps.slice(-4) ?? [])

/** What a command, file or browser tool works on, shown in its row: `$ ls -la`, a path, an address or what is typed. */
const summary = computed(() => {
  const value = props.item.input as { command?: unknown; path?: unknown; url?: unknown; text?: unknown; key?: unknown; ref?: unknown } | undefined
  if (typeof value?.command === 'string') return `$ ${value.command.split('\n')[0]}`
  if (props.item.action === 'files.search' && typeof (value as { query?: unknown })?.query === 'string') return `“${(value as { query: string }).query}”`
  if (typeof value?.path === 'string' && /^(files|terminal)\./.test(props.item.action)) return value.path
  if (props.item.action.startsWith('browser.')) {
    if (typeof value?.url === 'string') return value.url
    if (typeof value?.text === 'string') return `"${value.text.split('\n')[0]}"`
    if (typeof value?.key === 'string') return value.key
    if (typeof value?.ref === 'string') return value.ref
  }
  if (props.item.action === 'ui.ask') return ''
  return actionTarget(props.item.action, props.item.input, data)
})

/** How a command ended, on its row when it did not go well: its exit code, or that it timed out. */
const exit = computed(() => {
  if (props.item.state !== 'ok' || props.item.action !== 'terminal.run') return undefined
  const result = props.item.result as { code?: number | null; timedOut?: boolean } | undefined
  if (result?.timedOut) return { tone: 'warn', text: t('fairyRecord.timedOut') }
  if (typeof result?.code === 'number' && result.code !== 0) return { tone: 'bad', text: t('fairyRecord.exit', { code: result.code }) }
  return undefined
})

/** A question asked with ui.ask, and the answer picked, for its line once answered. */
const question = computed(() => {
  if (props.item.action !== 'ui.ask') return undefined
  const value = props.item.input as { question?: unknown } | undefined
  const answer = askAnswer(props.item.result)
  const text = !answer ? '' : answer.kind === 'choice' ? answer.label : answer.kind === 'other' ? answer.text : t(answer.kind === 'skipped' ? 'fairyRecord.askSkippedShort' : 'fairyRecord.askCancelledShort')
  return { text: typeof value?.question === 'string' ? value.question : '', answer: text, answered: answer?.kind === 'choice' || answer?.kind === 'other' }
})

// ---- pages Fairy offers or opens, and spots it points at, as cards with a button ----

const router = useRouter()
const route = useRoute()
const toast = useToast()

type Card =
  | { kind: 'offer' | 'opened'; path: string }
  | { kind: 'panel'; view: Omit<PanelView, 'id' | 'unseen'> }
  | { kind: 'spot'; target: string; message?: string }

const card = computed<Card | undefined>(() => {
  if (props.item.state !== 'ok') return undefined
  const result = (props.item.result ?? {}) as { offered?: string; panel?: string; path?: string; skipped?: boolean; offscreen?: boolean }
  const input = (props.item.input ?? {}) as { path?: string; kind?: PanelView['kind']; url?: string; title?: string; target?: string; message?: string }
  if (props.item.action === 'ui.navigate') {
    if (result.offered) return { kind: 'offer', path: result.offered }
    if (result.panel) return { kind: 'panel', view: { kind: 'page', path: result.panel } }
    if (result.path) return { kind: 'opened', path: result.path }
  }
  if (props.item.action === 'ui.panel' && input.kind && !result.skipped) {
    return { kind: 'panel', view: { kind: input.kind, ...(input.path ? { path: input.path } : {}), ...(input.url ? { url: input.url } : {}), ...(input.title ? { title: input.title } : {}) } }
  }
  if (props.item.action === 'ui.highlight' && result.offscreen && input.target) return { kind: 'spot', target: input.target, message: input.message }
  return undefined
})

/** A page's name from its first path segment, e.g. `/bots/abc/logs` → Bots. */
function pageName(path: string) {
  const first = path.split(/[/?#]/)[1] ?? ''
  return te(`nav.${first}`) ? t(`nav.${first}`) : path
}

const cardText = computed(() => {
  const value = card.value
  if (!value) return { icon: '', title: '', sub: '' }
  if (value.kind === 'spot') return { icon: 'i-lucide-locate-fixed', title: value.message || t('fairyCard.spot'), sub: t('fairyCard.spotHint') }
  if (value.kind !== 'panel') return { icon: 'i-lucide-app-window', title: pageName(value.path), sub: value.path }
  const view = value.view
  if (view.kind === 'page') return { icon: 'i-lucide-app-window', title: view.title ?? pageName(view.path ?? '/'), sub: `${t('fairyCard.inPanel')} · ${view.path}` }
  if (view.kind === 'web') return { icon: 'i-lucide-globe', title: view.title ?? view.url ?? '', sub: `${t('fairyCard.inPanel')} · ${view.url}` }
  return { icon: view.kind === 'terminal' ? 'i-lucide-square-terminal' : view.kind === 'browser' ? 'i-lucide-compass' : 'i-lucide-activity', title: t(`workspace.panel.${view.kind}`), sub: t('fairyCard.inPanel') }
})

/** The page it opened is the one you are on, so there is nothing to press. */
const here = computed(() => card.value?.kind === 'opened' && route.path === card.value.path.split(/[?#]/)[0])

async function act() {
  const value = card.value
  if (!value) return
  if (value.kind === 'spot') {
    const result = await highlight(value.target, value.message, { scroll: true })
    if (!result.ok) toast.warning(t('fairyCard.gone'))
  } else if (value.kind === 'panel') {
    // Outside the workspace the tab cannot open; the page itself can.
    if (workspace.active) workspace.openView(value.view)
    else if (value.view.kind === 'page' && value.view.path) router.push(value.view.path)
    else if (value.view.kind === 'web' && value.view.url) window.open(value.view.url, '_blank', 'noopener')
    else router.push('/fairy')
  } else {
    router.push(value.path)
  }
}

const actLabel = computed(() => (card.value?.kind === 'spot' ? t('fairyCard.show') : card.value?.kind === 'panel' ? t('fairyCard.view') : t('fairyCard.open')))

/** The first line of a failure, shown under the row so nobody has to open it to see why. */
const reason = computed(() => {
  if (props.item.state !== 'error' || !props.item.error) return ''
  return props.item.error.replace(/^Error:\s*/, '').split('\n')[0]
})
</script>

<template>
  <div v-if="isTask" class="tool task" :class="taskState">
    <button class="tool-row" type="button" @click="emit('toggle')">
      <Spin v-if="taskState === 'running'" :size="14" />
      <span v-else-if="taskState === 'done'" class="i-lucide-circle-check" color="var(--ok)" />
      <span v-else-if="taskState === 'confirm' || taskState === 'blocked'" class="i-lucide-hand" color="var(--warn)" />
      <span v-else class="i-lucide-circle-x" color="var(--bad)" />
      <span class="task-role">{{ roleName }}</span>
      <span class="tool-name task-text" :title="input.task">{{ input.task }}</span>
      <span class="tool-state">{{ t(`fairyTask.status.${taskState}`) }}</span>
    </button>
    <ul v-if="taskState === 'running' && steps.length" class="task-steps">
      <li v-for="step in steps" :key="step.id">
        <Spin v-if="step.state === 'running'" :size="10" />
        <span v-else-if="step.state === 'ok'" class="i-lucide-check" color="var(--ok)" />
        <span v-else-if="step.state === 'confirm'" class="i-lucide-hand" color="var(--warn)" />
        <span v-else class="i-lucide-x" color="var(--bad)" />
        <span class="task-step" :title="step.action">{{ stepLabel(step.action) }}</span>
      </li>
    </ul>
    <div v-if="item.task?.confirm" class="confirm">
      <p>{{ t('fairyTask.confirmText', { role: roleName, action: taskConfirmLabel }) }}</p>
      <ToolDetail :item="{ kind: 'tool', id: item.task.confirm.id, action: item.task.confirm.action, input: item.task.confirm.input, state: 'confirm' }" input-only />
      <div class="confirm-actions">
        <Button size="small" type="error" @click="emit('confirmTask', true)">{{ t('fairy.approve') }}</Button>
        <Button size="small" @click="emit('confirmTask', false)">{{ t('fairy.deny') }}</Button>
      </div>
    </div>
    <div v-else-if="report && (expanded || taskState !== 'done')" class="task-report">
      <p class="task-summary">{{ report.summary }}</p>
      <template v-if="expanded">
        <div v-if="report.findings?.length" class="label">{{ t('fairyTask.findings') }}</div>
        <ul v-if="report.findings?.length" class="task-findings">
          <li v-for="(finding, index) in report.findings" :key="index">
            <strong>{{ finding.title }}</strong>
            <span v-if="finding.where" class="mono task-where">{{ finding.where }}</span>
            <div v-if="finding.detail">{{ finding.detail }}</div>
            <pre v-if="finding.evidence" class="json mono">{{ finding.evidence }}</pre>
            <div v-if="finding.fix" class="task-fix">{{ t('fairyTask.fix') }}{{ finding.fix }}</div>
          </li>
        </ul>
        <div v-if="report.changes?.length" class="label">{{ t('fairyTask.changes') }}</div>
        <ul v-if="report.changes?.length" class="task-findings">
          <li v-for="(change, index) in report.changes" :key="index">{{ change }}</li>
        </ul>
      </template>
      <p v-if="report.next && (expanded || taskState === 'blocked')" class="task-next">{{ t('fairyTask.next') }}{{ report.next }}</p>
    </div>
    <div v-else-if="item.error && !item.task?.session" class="tool-reason" :title="item.error">{{ item.error }}</div>
    <div v-if="item.task?.session && (expanded || taskState === 'running')" class="task-actions">
      <Button size="tiny" secondary icon="i-lucide-scroll-text" @click="emit('openTask', item.task.session)">{{ t('fairyTask.open') }}</Button>
    </div>
  </div>
  <div v-else-if="card && !expanded" class="tool ui-card">
    <span class="ui-card-icon" :class="cardText.icon" />
    <button type="button" class="ui-card-text" :title="t('fairyCard.details')" @click="emit('toggle')">
      <span class="ui-card-title">{{ cardText.title }}</span>
      <span class="ui-card-sub mono">{{ cardText.sub }}</span>
    </button>
    <span v-if="here" class="ui-card-here"><span class="i-lucide-check" />{{ t('fairyCard.opened') }}</span>
    <Button v-else size="small" secondary @click="act">{{ actLabel }}</Button>
  </div>
  <AskCard v-else-if="ask" :ask="ask" @answer="(result) => emit('answer', result)" />
  <div v-else class="tool" :class="[item.state, { open: expanded }]">
    <button class="tool-row" type="button" @click="emit('toggle')">
      <Spin v-if="item.state === 'running'" :size="14" />
      <span v-else-if="question && item.state === 'ok'" class="i-lucide-circle-help tool-icon" :class="{ answered: question.answered }" />
      <span v-else-if="exit" class="i-lucide-circle-alert tool-icon" :class="exit.tone" />
      <span v-else-if="item.state === 'ok'" class="i-lucide-circle-check tool-icon" />
      <span v-else-if="item.state === 'confirm'" class="i-lucide-hand tool-icon" />
      <span v-else-if="item.state === 'declined'" class="i-lucide-ban tool-icon" />
      <span v-else class="i-lucide-circle-x tool-icon" />
      <template v-if="question">
        <span class="tool-name" :title="question.text">{{ question.text || label }}</span>
        <span v-if="question.answer" class="tool-answer" :class="{ muted: !question.answered }" :title="question.answer">{{ question.answer }}</span>
      </template>
      <template v-else>
        <span class="tool-name" :title="item.action">{{ label }}</span>
        <span v-if="summary" class="tool-summary" :class="{ mono: /^(terminal|files|browser)\./.test(item.action) }" :title="summary">{{ summary }}</span>
      </template>
      <span v-if="exit" class="tool-exit" :class="exit.tone">{{ exit.text }}</span>
      <Tag v-if="item.risk === 'dangerous' && item.state === 'confirm'" size="tiny" type="error">{{ t('fairy.dangerous') }}</Tag>
      <span v-if="item.state !== 'ok'" class="tool-state">{{ t(`fairy.state.${item.state}`) }}</span>
      <span class="i-lucide-chevron-down tool-chevron" />
    </button>
    <div v-if="reason && !expanded" class="tool-reason" :title="reason">{{ reason }}</div>
    <div v-if="item.state === 'confirm'" class="confirm">
      <p>{{ t('fairy.confirmText', { action: summary && !/^(terminal|files|browser)\./.test(item.action) ? `${label} ${summary}` : label }) }}</p>
      <ToolDetail :item="item" input-only />
      <div class="confirm-actions">
        <Button size="small" type="error" @click="emit('confirm', true)">{{ t('fairy.approve') }}</Button>
        <Button size="small" @click="emit('confirm', false)">{{ t('fairy.deny') }}</Button>
      </div>
    </div>
    <div v-else-if="expanded" class="tool-detail">
      <ToolDetail :item="item" />
    </div>
  </div>
</template>

<style scoped>
.task.confirm,
.task.blocked {
  border-color: var(--warn);
}

.task-role {
  flex: none;
  padding: 0 6px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.14);
  font-size: 12px;
}

.task-text {
  font-family: inherit;
}

.task-steps {
  margin: -2px 10px 8px 32px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  opacity: 0.8;
}

.task-steps li {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.task-step {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.task-report {
  padding: 0 10px 8px 32px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.task-report p {
  margin: 0;
}

.task-findings {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.task-where {
  margin-left: 6px;
  font-size: 12px;
  opacity: 0.7;
}

.task-fix,
.task-next {
  color: var(--warn);
}

.task-actions {
  padding: 0 10px 8px 32px;
}

.tool {
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 13px;
  transition: border-color 0.15s, background 0.15s;
}

/* Waiting on you: yellow. Done: a green check and a quieter line. Failed: red, with why. Declined: struck out. */
.tool.confirm {
  border-color: var(--warn);
  background: var(--warn-soft);
}

.tool-icon {
  flex: none;
}

.tool.ok .tool-icon {
  color: var(--ok);
}

.tool.ok .tool-icon.i-lucide-circle-help {
  color: var(--fg3);
}

.tool.ok .tool-icon.answered {
  color: var(--primary);
}

.tool.ok:not(.open) .tool-row {
  color: var(--fg2);
}

.tool.ok:not(.open, :hover) {
  border-color: transparent;
  background: rgba(127, 127, 127, 0.05);
}

.tool.confirm .tool-icon {
  color: var(--warn);
}

.tool.error {
  border-color: var(--bad-soft);
}

.tool.error .tool-icon,
.tool.error .tool-state {
  color: var(--bad);
  opacity: 1;
}

.tool.declined .tool-icon {
  color: var(--fg3);
}

.tool.declined .tool-name {
  color: var(--fg3);
  text-decoration: line-through;
}

.tool-chevron {
  flex: none;
  font-size: 14px;
  color: var(--fg3);
  opacity: 0;
  transition: transform 0.15s, opacity 0.15s;
}

.tool-row:hover .tool-chevron,
.tool.open .tool-chevron {
  opacity: 1;
}

.tool.open .tool-chevron {
  transform: rotate(180deg);
}

.tool-answer {
  flex: none;
  max-width: 45%;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 12px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tool-answer {
  margin-right: auto;
}

.tool.ok .tool-icon.bad,
.tool-exit.bad {
  color: var(--bad);
}

.tool.ok .tool-icon.warn,
.tool-exit.warn {
  color: var(--warn);
}

.tool-exit {
  flex: none;
  font-size: 12px;
}

.tool-answer.muted {
  background: rgba(127, 127, 127, 0.12);
  color: var(--fg3);
}

.tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.tool-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tool-state {
  opacity: 0.6;
  font-size: 12px;
}

.tool-reason {
  margin: -2px 10px 7px 32px;
  font-size: 12px;
  color: var(--bad);
  opacity: 0.85;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tool-detail,
.confirm {
  padding: 0 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.confirm p {
  margin: 0;
}

.confirm-actions {
  display: flex;
  gap: 8px;
}

.label {
  font-size: 12px;
  opacity: 0.6;
}
.tool-name:has(+ .tool-summary),
.tool-name:has(+ .tool-answer) {
  flex: 0 1 auto;
}

.tool-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--fg3);
  font-size: 12px;
}

/* A page Fairy offers or opened, a tab it put in the panel, or a spot off screen: one line and a button. */
.ui-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--s1);
}

.ui-card-icon {
  flex: none;
  font-size: 18px;
  color: var(--primary);
}

.ui-card-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.ui-card-title {
  font-weight: 500;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ui-card-sub {
  font-size: 12px;
  color: var(--fg3);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ui-card-here {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--fg3);
}
</style>
