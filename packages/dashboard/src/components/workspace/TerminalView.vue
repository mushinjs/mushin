<script setup lang="ts">
import { Button, Input, Tooltip } from '@mushinjs/ui'
import { AnsiUp } from 'ansi_up'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call, on } from '../../api'
import { workspace } from '../../stores/workspace'

/**
 * The panel's terminal tab: commands Fairy (or you) ran on this machine with their live output. Type a command at the
 * bottom to run it yourself. Needs the Terminal plugin.
 */
interface ProcessInfo {
  id: string
  command: string
  cwd: string
  startedAt: number
  endedAt?: number
  code?: number | null
  running: boolean
  error?: string
  session?: string
  size: number
}

const { t } = useI18n()
const processes = ref<ProcessInfo[]>([])
const available = ref(true)
const selected = ref<string>()
const texts = ref<Record<string, string>>({})
/** Where each loaded output ends in the whole output, so a batch that arrives twice is added once. */
const ends = new Map<string, number>()
const command = ref('')
const starting = ref(false)
const error = ref('')
const output = ref<HTMLElement>()
/** Follow the newest output unless the user scrolled up. */
const pinned = ref(true)

const ansi = new AnsiUp()
ansi.use_classes = true

const current = computed(() => processes.value.find((item) => item.id === selected.value))
const html = computed(() => (selected.value ? ansi.ansi_to_html(texts.value[selected.value] ?? '') : ''))

async function refresh() {
  try {
    processes.value = await call<ProcessInfo[]>('terminal.processes')
    available.value = true
    if (!selected.value || !processes.value.some((item) => item.id === selected.value)) select(processes.value[0]?.id)
  } catch {
    available.value = false
  }
}

async function select(id?: string) {
  selected.value = id
  pinned.value = true
  if (!id || texts.value[id] !== undefined) return scrollDown()
  try {
    const out = await call<{ text: string; next: number }>('terminal.output', { id })
    texts.value = { ...texts.value, [id]: out.text }
    ends.set(id, out.next)
  } catch {}
  scrollDown()
}

async function scrollDown() {
  await nextTick()
  if (pinned.value && output.value) output.value.scrollTop = output.value.scrollHeight
}

function onScroll() {
  const el = output.value
  if (el) pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

async function run() {
  const text = command.value.trim()
  if (!text) return
  starting.value = true
  error.value = ''
  try {
    const started = await call<ProcessInfo>('terminal.start', { command: text })
    command.value = ''
    if (texts.value[started.id] === undefined) {
      texts.value = { ...texts.value, [started.id]: '' }
      ends.set(started.id, 0)
    }
    if (!processes.value.some((item) => item.id === started.id)) processes.value = [started, ...processes.value]
    select(started.id)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    starting.value = false
  }
}

const stop = (id: string) => call('terminal.stop', { id }).catch((err) => (error.value = (err as Error).message))

async function remove(id: string) {
  await call('terminal.processes.remove', { id }).catch(() => {})
}

const offs: (() => void)[] = []
onMounted(() => {
  refresh()
  offs.push(on('terminal/process', (info: ProcessInfo & { removed?: boolean }) => {
    const list = processes.value.filter((item) => item.id !== info.id)
    if (info.removed) {
      processes.value = list
      if (selected.value === info.id) select(list[0]?.id)
      return
    }
    processes.value = [info, ...list].sort((a, b) => b.startedAt - a.startedAt)
    // A new command comes to the front.
    if (info.running && !list.length) select(info.id)
    else if (info.running && texts.value[info.id] === undefined) {
      texts.value = { ...texts.value, [info.id]: '' }
      ends.set(info.id, 0)
      select(info.id)
    }
  }))
  offs.push(on('terminal/output', ({ id, text, at }: { id: string; text: string; at: number }) => {
    const end = ends.get(id)
    if (texts.value[id] === undefined || end === undefined || at + text.length <= end) return
    texts.value = { ...texts.value, [id]: texts.value[id] + text.slice(Math.max(0, end - at)) }
    ends.set(id, at + text.length)
    if (id === selected.value) scrollDown()
  }))
  offs.push(on('manager/changed', () => !available.value && refresh()))
})
onBeforeUnmount(() => offs.forEach((off) => off()))

watch(selected, () => (error.value = ''))

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const stateOf = (item: ProcessInfo) => (item.running ? 'running' : item.code === 0 ? 'ok' : 'bad')
const openPlugins = () => workspace.openView({ kind: 'page', path: '/plugins?highlight=%40mushinjs%2Fplugin-terminal' })
</script>

<template>
  <div class="term">
    <div v-if="!available" class="off">
      <span class="i-lucide-terminal-square off-icon" />
      <p>{{ t('workspace.terminal.unavailable') }}</p>
      <Button size="small" secondary @click="openPlugins">{{ t('workspace.terminal.openPlugins') }}</Button>
    </div>
    <template v-else>
      <div class="list" role="listbox" :aria-label="t('workspace.terminal.commands')">
        <p v-if="!processes.length" class="muted">{{ t('workspace.terminal.empty') }}</p>
        <button
          v-for="item in processes"
          :key="item.id"
          type="button"
          role="option"
          class="row"
          :class="{ on: item.id === selected }"
          :aria-selected="item.id === selected"
          :title="`${item.command}\n${item.cwd}`"
          @click="select(item.id)"
        >
          <span class="state" :class="stateOf(item)" />
          <span class="cmd mono">{{ item.command }}</span>
          <span v-if="item.session" class="by i-lucide-sparkles" :title="t('workspace.terminal.byFairy')" />
          <span class="when">{{ item.running ? t('workspace.terminal.running') : item.code === null || item.code === undefined ? (item.error ?? t('workspace.terminal.stopped')) : t('workspace.terminal.exit', { code: item.code }) }}</span>
        </button>
      </div>

      <div v-if="current" class="head">
        <span class="mono head-cwd" :title="current.cwd">{{ current.cwd }}</span>
        <span class="muted">{{ time(current.startedAt) }}</span>
        <Tooltip v-if="current.running">
          <template #trigger><Button size="tiny" quaternary circle icon="i-lucide-square" :aria-label="t('workspace.terminal.stop')" @click="stop(current.id)" /></template>
          {{ t('workspace.terminal.stop') }}
        </Tooltip>
        <Tooltip v-else>
          <template #trigger><Button size="tiny" quaternary circle icon="i-lucide-trash-2" :aria-label="t('workspace.terminal.remove')" @click="remove(current.id)" /></template>
          {{ t('workspace.terminal.remove') }}
        </Tooltip>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -- ansi_up escapes the text and only adds spans with classes -->
      <pre ref="output" class="out mono" @scroll="onScroll"><span v-if="current" class="prompt">$ {{ current.command }}
</span><span v-html="html" /></pre>

      <form class="input" @submit.prevent="run">
        <span class="prompt-sign mono">$</span>
        <Input v-model:value="command" size="small" class="mono" :placeholder="t('workspace.terminal.placeholder')" :disabled="starting" />
        <Button size="small" attr-type="submit" :loading="starting" :disabled="!command.trim()">{{ t('workspace.terminal.run') }}</Button>
      </form>
      <p v-if="error" class="error">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.term {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  font-size: 13px;
}

.off {
  margin: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  color: var(--fg2);
}

.off-icon {
  font-size: 28px;
  color: var(--fg3);
}

.list {
  flex: none;
  max-height: 32%;
  overflow-y: auto;
  padding: 6px;
  border-bottom: 1px solid var(--line);
}

.row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.row:hover {
  background: var(--s2);
}

.row.on {
  background: var(--primary-soft);
}

.state {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg3);
}

.state.running {
  background: var(--primary);
  animation: pulse 1.2s ease-in-out infinite;
}

.state.ok { background: var(--ok); }
.state.bad { background: var(--bad); }

@keyframes pulse {
  50% { opacity: 0.35; }
}

.cmd {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
}

.by {
  flex: none;
  color: var(--primary);
  font-size: 12px;
}

.when {
  flex: none;
  max-width: 35%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--fg3);
  font-size: 12px;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
}

.head-cwd {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--fg2);
}

.muted {
  margin: 0;
  color: var(--fg3);
  font-size: 12px;
}

.list > .muted {
  padding: 6px 8px;
}

.out {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  background: var(--bg);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.prompt {
  color: var(--primary);
}

.input {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--line);
}

.prompt-sign {
  color: var(--fg3);
}

.error {
  margin: 0;
  padding: 0 12px 8px;
  color: var(--bad);
  font-size: 12px;
}

.out :deep(.ansi-red-fg), .out :deep(.ansi-bright-red-fg) { color: var(--bad); }
.out :deep(.ansi-green-fg), .out :deep(.ansi-bright-green-fg) { color: var(--ok); }
.out :deep(.ansi-yellow-fg), .out :deep(.ansi-bright-yellow-fg) { color: var(--warn); }
.out :deep(.ansi-blue-fg), .out :deep(.ansi-bright-blue-fg),
.out :deep(.ansi-magenta-fg), .out :deep(.ansi-bright-magenta-fg) { color: var(--primary); }
.out :deep(.ansi-cyan-fg), .out :deep(.ansi-bright-cyan-fg) { color: var(--primary); }
.out :deep(.ansi-black-fg), .out :deep(.ansi-bright-black-fg) { color: var(--fg3); }
.out :deep(.ansi-bold) { font-weight: 600; }
</style>
