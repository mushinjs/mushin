<script setup lang="ts">
import { Button, Spin, Tag } from '@mushinjs/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { type ChatItem, DELEGATE } from '../../stores/fairy'
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

/** What a command or file tool works on, shown in its row: `$ ls -la` or a path. */
const summary = computed(() => {
  const value = props.item.input as { command?: unknown; path?: unknown } | undefined
  if (typeof value?.command === 'string') return `$ ${value.command.split('\n')[0]}`
  if (typeof value?.path === 'string' && /^(files|terminal)\./.test(props.item.action)) return value.path
  return ''
})
const command = computed(() => {
  const value = props.item.input as { command?: unknown; cwd?: unknown } | undefined
  return typeof value?.command === 'string' ? { text: value.command, cwd: typeof value.cwd === 'string' ? value.cwd : '' } : undefined
})

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

.json.command {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
