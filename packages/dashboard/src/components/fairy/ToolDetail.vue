<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChatItem } from '../../stores/fairy'
import { formatBytes } from '../../utils'
import CodeLines from './CodeLines.vue'
import JsonTree from './JsonTree.vue'
import { actionLabel, askAnswer, diff, KEY_FIELDS, numbered, recordKind } from './records'

/**
 * An opened tool call, drawn by what it is: a command with its exit code and output, a file read or
 * changed, a web page, a question with the answer picked, or the input and result as fields and a tree.
 * `inputOnly` shows what it is about to do, for an approval.
 */
type ToolItem = Extract<ChatItem, { kind: 'tool' }>
const props = defineProps<{ item: ToolItem; inputOnly?: boolean }>()

const { t, te } = useI18n()

type Fields = Record<string, any>
const kind = computed(() => recordKind(props.item.action))
const input = computed<Fields>(() => (props.item.input && typeof props.item.input === 'object' ? props.item.input as Fields : {}))
const result = computed<Fields>(() => (props.item.result && typeof props.item.result === 'object' ? props.item.result as Fields : {}))
const done = computed(() => !props.inputOnly && props.item.state === 'ok' && props.item.result !== undefined)
const error = computed(() => (props.inputOnly || props.item.state === 'declined' ? '' : props.item.error ?? ''))

const isPlain = (value: unknown) => value === null || typeof value !== 'object'
const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))

// ---- commands ----

const command = computed(() => (typeof input.value.command === 'string' ? input.value.command : ''))

function exited(code: unknown) {
  if (code === 0) return { tone: 'ok', text: t('fairyRecord.exit', { code }) }
  if (typeof code === 'number') return { tone: 'bad', text: t('fairyRecord.exit', { code }) }
  return { tone: 'muted', text: t('fairyRecord.stopped') }
}

const term = computed((): { tone: string; text: string; output: string; cut?: boolean } | undefined => {
  if (!done.value) return undefined
  const value = result.value
  switch (props.item.action) {
    case 'terminal.run':
      return { ...(value.timedOut ? { tone: 'warn', text: t('fairyRecord.timedOut') } : exited(value.code)), output: String(value.output ?? ''), cut: !!value.truncated }
    case 'terminal.output':
      return { ...(value.running ? { tone: 'info', text: t('fairyRecord.stillRunning') } : exited(value.code)), output: String(value.text ?? ''), cut: !!value.truncated || value.from > 0 }
    case 'terminal.start':
      return value.running ? { tone: 'info', text: t('fairyRecord.started'), output: '' } : { tone: 'bad', text: String(value.error ?? t('fairyRecord.stopped')), output: '' }
    case 'terminal.stop':
      return { tone: 'muted', text: t('fairyRecord.stopped'), output: '' }
    default:
      return undefined
  }
})
const outputLines = computed(() => (term.value?.output ? term.value.output.replace(/\n$/, '').split('\n').map((text) => ({ text })) : []))

// ---- files ----

const fileLines = computed(() => {
  const value = result.value
  if (kind.value === 'read' && done.value && typeof value.text === 'string') return numbered(value.text, Number(value.from) || 1)
  if (kind.value === 'edit' && typeof input.value.old === 'string') return diff(input.value.old, String(input.value.new ?? ''))
  if (kind.value === 'write' && typeof input.value.content === 'string') return input.value.content.split('\n').map((text: string) => ({ text, mark: '+' as const }))
  return []
})

const fileMeta = computed(() => {
  const value = result.value
  if (!done.value) return ''
  if (kind.value === 'read') return t('fairyRecord.lines', { from: value.from, to: value.to, total: value.lines })
  if (kind.value === 'edit') return t('fairyRecord.replaced', { n: value.replaced ?? 1 })
  if (kind.value === 'write') return t(value.created ? 'fairyRecord.created' : 'fairyRecord.overwritten', { size: formatBytes(Number(value.bytes) || 0) })
  if (kind.value === 'list') return t('fairyRecord.entries', { n: value.entries?.length ?? 0 })
  if (kind.value === 'grep') return t('fairyRecord.matches', { n: value.matches?.length ?? 0 })
  return ''
})

const entries = computed<{ path: string; type?: string; size?: number }[]>(() => (Array.isArray(result.value.entries) ? result.value.entries : []))
const matches = computed<{ path: string; line: number; text: string }[]>(() => (Array.isArray(result.value.matches) ? result.value.matches : []))

// ---- browser ----

/** What a browser step was given, apart from the tab. */
const browserInput = computed(() => Object.entries(input.value).filter(([key, value]) => key !== 'tab' && key !== 'url' && isPlain(value)))
const snapshotLines = computed(() => (typeof result.value.snapshot === 'string' ? result.value.snapshot.split('\n').map((text: string) => ({ text })) : []))

// ---- a question ----

const answer = computed(() => askAnswer(props.item.result))
const options = computed<{ label: string; description?: string }[]>(() => (Array.isArray(input.value.options) ? input.value.options : []))

// ---- tools found ----

const foundTools = computed<string[]>(() => (Array.isArray(result.value.tools) ? result.value.tools.map((name: unknown) => String(name).replaceAll('__', '.')) : []))

// ---- anything else: fields, and a tree for what is nested ----

const inputFields = computed(() => Object.entries(input.value))

/** A result with few fields shows them all; a bigger one shows its main fields and folds the rest. */
const resultView = computed(() => {
  const value = props.item.result
  if (!done.value) return undefined
  if (value === null || typeof value !== 'object') return { kind: 'text' as const, text: show(value) }
  if (Array.isArray(value)) return { kind: 'tree' as const }
  const all = Object.entries(value)
  if (all.length <= 6) return { kind: 'fields' as const, fields: all, rest: undefined }
  const main = KEY_FIELDS.filter((key) => key in value).map((key) => [key, (value as Fields)[key]] as [string, unknown])
  if (!main.length) return { kind: 'tree' as const }
  const rest = Object.fromEntries(all.filter(([key]) => !KEY_FIELDS.includes(key)))
  return { kind: 'fields' as const, fields: main, rest }
})
</script>

<template>
  <div class="rec">
    <!-- A command: what ran, where, how it ended, and the end of its output. -->
    <template v-if="kind === 'terminal'">
      <!-- The row shows a short command; a long one shows here in full. -->
      <pre v-if="command && (command.includes('\n') || command.length > 40)" class="rec-cmd mono">$ {{ command }}</pre>
      <div v-if="input.cwd" class="rec-sub mono">{{ t('fairyRecord.cwd', { cwd: input.cwd }) }}</div>
      <pre v-if="item.action === 'terminal.write' && typeof input.text === 'string'" class="rec-cmd mono">{{ input.text }}</pre>
      <div v-if="term" class="rec-meta">
        <!-- A failed run already says so on its row. -->
        <span v-if="item.action !== 'terminal.run' || term.tone === 'ok'" class="pill" :class="term.tone">{{ term.text }}</span>
        <span v-if="term.cut" class="rec-sub">{{ t('fairyRecord.truncated') }}</span>
      </div>
      <CodeLines v-if="outputLines.length" :lines="outputLines" :limit="20" tail />
    </template>

    <!-- A file: its path, what was read or changed, and the lines. -->
    <template v-else-if="kind === 'read' || kind === 'edit' || kind === 'write' || kind === 'list' || kind === 'grep'">
      <div v-if="fileMeta" class="rec-sub">{{ fileMeta }}</div>
      <CodeLines v-if="fileLines.length" :lines="fileLines" :limit="kind === 'read' ? 40 : 30" />
      <ul v-if="kind === 'list' && entries.length" class="rec-list mono">
        <li v-for="entry in entries.slice(0, 200)" :key="entry.path">
          <span :class="entry.type === 'dir' ? 'i-lucide-folder' : 'i-lucide-file'" />
          <span class="rec-grow">{{ entry.path }}</span>
          <span v-if="entry.size !== undefined" class="rec-sub">{{ formatBytes(entry.size) }}</span>
        </li>
      </ul>
      <ul v-if="kind === 'grep' && matches.length" class="rec-list mono">
        <li v-for="(match, index) in matches" :key="index">
          <span class="rec-sub">{{ match.path }}:{{ match.line }}</span>
          <span class="rec-grow rec-clip">{{ match.text.trim() }}</span>
        </li>
      </ul>
    </template>

    <!-- A web page: what was done on it, and the page it ended on. -->
    <template v-else-if="kind === 'browser'">
      <div v-if="browserInput.length" class="kv">
        <template v-for="[key, value] in browserInput" :key="key">
          <span class="kv-key">{{ key }}</span>
          <span class="kv-val">{{ show(value) }}</span>
        </template>
      </div>
      <template v-if="done">
        <div v-if="result.title || result.url" class="rec-page">
          <span class="rec-page-title">{{ result.title || t('fairyRecord.untitledPage') }}</span>
          <!-- The address it was asked to open is on the row; one it ended up on instead shows here. -->
          <a v-if="result.url && result.url !== input.url" class="mono rec-sub rec-clip" :href="result.url" target="_blank" rel="noopener">{{ result.url }}</a>
        </div>
        <div v-if="result.path" class="rec-sub mono">{{ result.path }}</div>
        <details v-if="snapshotLines.length" class="rec-fold">
          <summary>{{ t('fairyRecord.snapshot', { n: snapshotLines.length }) }}</summary>
          <CodeLines :lines="snapshotLines" :limit="60" />
        </details>
      </template>
    </template>

    <!-- A question: every option, with the one picked marked. -->
    <template v-else-if="kind === 'ask'">
      <ul class="rec-options">
        <li v-for="(option, index) in options" :key="index" :class="{ picked: answer?.kind === 'choice' && answer.index === index }">
          <span :class="answer?.kind === 'choice' && answer.index === index ? 'i-lucide-circle-check' : 'i-lucide-circle'" />
          <span class="rec-grow">
            {{ option.label }}
            <small v-if="option.description">{{ option.description }}</small>
          </span>
          <span v-if="input.recommended === index" class="rec-sub">{{ t('fairyPalette.recommended') }}</span>
        </li>
      </ul>
      <div v-if="answer?.kind === 'other'" class="rec-meta"><span class="pill ok">{{ t('fairyRecord.answeredOther') }}</span>{{ answer.text }}</div>
      <div v-else-if="answer?.kind === 'skipped'" class="rec-sub">{{ t('fairyRecord.askSkipped') }}</div>
      <div v-else-if="answer?.kind === 'cancelled'" class="rec-sub">{{ t('fairyRecord.askCancelled') }}</div>
    </template>

    <!-- Tools Fairy looked up, by name. -->
    <template v-else-if="kind === 'tools'">
      <div class="rec-meta"><span class="i-lucide-search rec-icon" /><span>“{{ input.query }}”</span></div>
      <ul v-if="done" class="rec-list">
        <li v-for="name in foundTools" :key="name">
          <span class="rec-grow">{{ actionLabel(name, t, te) }}</span>
          <span class="mono rec-sub">{{ name }}</span>
        </li>
        <li v-if="!foundTools.length" class="rec-sub">{{ t('fairyRecord.noTools') }}</li>
      </ul>
    </template>

    <!-- Anything else: the input as fields, the result's main fields, and the rest folded. -->
    <template v-else>
      <template v-if="inputFields.length">
        <div v-if="!inputOnly" class="label">{{ t('fairy.input') }}</div>
        <div class="kv">
          <template v-for="[key, value] in inputFields" :key="key">
            <span class="kv-key">{{ key }}</span>
            <span v-if="isPlain(value)" class="kv-val">{{ show(value) }}</span>
            <JsonTree v-else class="kv-val" :value="value" :open="false" />
          </template>
        </div>
      </template>
      <template v-if="resultView">
        <div class="label">{{ t('fairy.output') }}</div>
        <div v-if="resultView.kind === 'text'" class="kv-val rec-text">{{ resultView.text }}</div>
        <JsonTree v-else-if="resultView.kind === 'tree'" :value="item.result" />
        <template v-else>
          <div class="kv">
            <template v-for="[key, value] in resultView.fields" :key="key">
              <span class="kv-key">{{ key }}</span>
              <span v-if="isPlain(value)" class="kv-val">{{ show(value) }}</span>
              <JsonTree v-else class="kv-val" :value="value" :open="false" />
            </template>
          </div>
          <JsonTree v-if="resultView.rest" :value="resultView.rest" :label="t('fairyRecord.rest')" :open="false" />
        </template>
      </template>
    </template>

    <div v-if="error" class="rec-error">{{ error.replace(/^Error:\s*/, '') }}</div>
  </div>
</template>

<style scoped>
.rec {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.label {
  font-size: 12px;
  color: var(--fg3);
}

.rec-cmd {
  margin: 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.1);
  white-space: pre-wrap;
  word-break: break-word;
}

.rec-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
}

.rec-icon {
  flex: none;
  color: var(--fg3);
}

.rec-path {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--fg);
}

.rec-sub {
  flex: none;
  color: var(--fg3);
  font-size: 12px;
}

.rec-grow {
  flex: 1;
  min-width: 0;
}

.rec-clip {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.pill {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 12px;
}

.pill.ok {
  background: var(--ok-soft);
  color: var(--ok);
}

.pill.bad {
  background: var(--bad-soft);
  color: var(--bad);
}

.pill.warn {
  background: var(--warn-soft);
  color: var(--warn);
}

.pill.info {
  background: var(--info-soft);
  color: var(--info);
}

.pill.muted {
  background: rgba(127, 127, 127, 0.12);
  color: var(--fg2);
}

.rec-list {
  margin: 0;
  padding: 6px 10px;
  max-height: 240px;
  overflow: auto;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.1);
  list-style: none;
  font-size: 12px;
}

.rec-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  line-height: 1.7;
}

.rec-list [class^='i-lucide'] {
  flex: none;
  color: var(--fg3);
}

.rec-page {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 6px 10px;
  border-left: 2px solid var(--line-strong);
}

.rec-page-title {
  font-weight: 500;
}

.rec-fold summary {
  font-size: 12px;
  color: var(--fg2);
  cursor: pointer;
}

.rec-fold[open] summary {
  margin-bottom: 6px;
}

.rec-options {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rec-options li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--fg2);
}

.rec-options li [class^='i-lucide'] {
  flex: none;
  margin-top: 3px;
}

.rec-options li.picked {
  border-color: var(--ok);
  background: var(--ok-soft);
  color: var(--fg);
}

.rec-options li.picked [class^='i-lucide'] {
  color: var(--ok);
}

.rec-options small {
  display: block;
  color: var(--fg3);
  font-size: 12px;
}

.kv {
  display: grid;
  grid-template-columns: minmax(64px, max-content) minmax(0, 1fr);
  gap: 3px 12px;
  font-size: 12px;
}

.kv-key {
  color: var(--fg3);
  font-family: var(--mono);
}

.kv-val {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.kv .jt {
  margin-left: -16px;
}

.rec-text {
  font-size: 12px;
}

.rec-error {
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--bad-soft);
  color: var(--bad);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
