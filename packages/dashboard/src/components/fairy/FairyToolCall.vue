<script setup lang="ts">
import { Button, Spin, Tag, useToast } from '@mushinjs/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { highlight } from '../../highlight'
import { type ChatItem, DELEGATE } from '../../stores/fairy'
import { type PanelView, workspace } from '../../stores/workspace'
import type { FairyTaskReport } from '../../types'
import { pretty } from '../../utils'

/**
 * One tool call of a Fairy reply: what it called, how it went, and its input and output on demand. A task
 * handed to a helper shows as a card: the helper, the task, what it is doing, and its report.
 */
const props = defineProps<{ item: Extract<ChatItem, { kind: 'tool' }>; expanded: boolean }>()
const emit = defineEmits<{ toggle: []; confirm: [approved: boolean]; confirmTask: [approved: boolean]; openTask: [session: string] }>()

const { t, te } = useI18n()

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
  if (typeof value?.path === 'string' && /^(files|terminal)\./.test(props.item.action)) return value.path
  if (props.item.action.startsWith('browser.')) {
    if (typeof value?.url === 'string') return value.url
    if (typeof value?.text === 'string') return `"${value.text.split('\n')[0]}"`
    if (typeof value?.key === 'string') return value.key
    if (typeof value?.ref === 'string') return value.ref
  }
  return ''
})
const command = computed(() => {
  const value = props.item.input as { command?: unknown; cwd?: unknown } | undefined
  return typeof value?.command === 'string' ? { text: value.command, cwd: typeof value.cwd === 'string' ? value.cwd : '' } : undefined
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
        <span class="mono">{{ step.action }}</span>
      </li>
    </ul>
    <div v-if="item.task?.confirm" class="confirm">
      <p>{{ t('fairyTask.confirmText', { role: roleName, action: item.task.confirm.action }) }}</p>
      <pre class="json mono">{{ pretty(item.task.confirm.input) }}</pre>
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
  <div v-else class="tool" :class="item.state">
    <button class="tool-row" type="button" @click="emit('toggle')">
      <Spin v-if="item.state === 'running'" :size="14" />
      <span v-else-if="item.state === 'ok'" class="i-lucide-circle-check" color="var(--ok)" />
      <span v-else-if="item.state === 'confirm'" class="i-lucide-hand" color="var(--warn)" />
      <span v-else class="i-lucide-circle-x" color="var(--bad)" />
      <span class="mono tool-name">{{ item.action }}</span>
      <span v-if="summary" class="mono tool-summary" :title="summary">{{ summary }}</span>
      <Tag v-if="item.risk === 'dangerous'" size="tiny" type="error">{{ t('fairy.dangerous') }}</Tag>
      <span class="tool-state">{{ t(`fairy.state.${item.state}`) }}</span>
    </button>
    <div v-if="reason && !expanded" class="tool-reason" :title="reason">{{ reason }}</div>
    <div v-if="item.state === 'confirm'" class="confirm">
      <p>{{ t('fairy.confirmText', { action: item.action }) }}</p>
      <pre v-if="command" class="json mono command">$ {{ command.text }}<template v-if="command.cwd">{{ '\n' }}# {{ command.cwd }}</template></pre>
      <pre v-else class="json mono">{{ pretty(item.input) }}</pre>
      <div class="confirm-actions">
        <Button size="small" type="error" @click="emit('confirm', true)">{{ t('fairy.approve') }}</Button>
        <Button size="small" @click="emit('confirm', false)">{{ t('fairy.deny') }}</Button>
      </div>
    </div>
    <div v-else-if="expanded" class="tool-detail">
      <div class="label">{{ t('fairy.input') }}</div>
      <pre class="json mono">{{ pretty(item.input) }}</pre>
      <template v-if="item.result !== undefined || item.error">
        <div class="label">{{ t('fairy.output') }}</div>
        <pre class="json mono">{{ item.error ?? pretty(item.result) }}</pre>
      </template>
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

.task-steps .mono {
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
  border: 1px solid rgba(127, 127, 127, 0.2);
  border-radius: 8px;
  font-size: 13px;
}

.tool.confirm {
  border-color: var(--warn);
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
.tool-name:has(+ .tool-summary) {
  flex: none;
  max-width: 45%;
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

.json.command {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
