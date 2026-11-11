<script setup lang="ts">
import { Avatar, Popover, Tag } from '@mushinjs/ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { call } from '../api'
import { avatarColor, initial } from '../botAvatar'
import type { MessageRecord } from '../types'
import { formatBytes, formatTime } from '../utils'
import MessageContent from './message/MessageContent.vue'

const props = defineProps<{ record: MessageRecord; avatar?: string; name?: string }>()
const emit = defineEmits<{ newFlow: []; quote: [] }>()
const { t, te } = useI18n()
const router = useRouter()

const outgoing = computed(() => props.record.direction === 'out')
const who = computed(() => props.name ?? props.record.user.name ?? props.record.user.id)

// Opens on hover and on keyboard focus, so the details are reachable without a mouse. Closing waits
// a moment, so the pointer can move from the bubble into the panel to click a flow or an action.
const open = ref(false)
let closeTimer: ReturnType<typeof setTimeout> | undefined
function show() {
  clearTimeout(closeTimer)
  open.value = true
}
function hide(delay = 180) {
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => (open.value = false), delay)
}
onBeforeUnmount(() => clearTimeout(closeTimer))

// ---- the flows an incoming message started, read the first time its panel opens ----

interface RunRow {
  id: string
  flowId: string
  flowName: string
  status: string
  startedAt: number
  error?: string
}

const runs = ref<RunRow[]>()
const runsError = ref(false)
const loadingRuns = ref(false)

async function loadRuns() {
  if (outgoing.value || loadingRuns.value) return
  loadingRuns.value = true
  try {
    runs.value = (await call<{ runs: RunRow[] }>('flows.history', { bot: props.record.botId, message: props.record.id, limit: 20 })).runs
    runsError.value = false
  } catch {
    runsError.value = true
  } finally {
    loadingRuns.value = false
  }
}

// Read again on each open while none were found: a flow may still be starting when the pointer arrives.
watch(open, (value) => {
  if (value && !runs.value?.length) void loadRuns()
})

// ---- what handling the message cost, kept in memory by the server; read on every open ----

interface UsageEvent {
  kind: string
  plugin?: string
  provider?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  latencyMs?: number
  ok?: boolean
  note?: string
}

interface MessageUsage {
  events: UsageEvent[]
  bytes?: number
  sendMs?: number
  cause?: string
  causeEvents?: UsageEvent[]
}

const cost = ref<MessageUsage | null>()
watch(open, async (value) => {
  if (!value) return
  try {
    cost.value = await call<MessageUsage | null>('bots.usage', { id: props.record.botId, message: props.record.id })
  } catch {
    cost.value = undefined
  }
})

const tokensOf = (events: UsageEvent[]) => events.reduce((sum, event) => sum + (event.inputTokens ?? 0) + (event.outputTokens ?? 0), 0)
const kindLabel = (kind: string) => (te(`usage.kind.${kind}`) ? t(`usage.kind.${kind}`) : kind)
const shortPlugin = (name?: string) => name?.replace(/^@mushinjs\/(bot-)?plugin-/, '')
const speed = (bytes: number, ms: number) => formatBytes(Math.round(bytes / Math.max(ms, 1) * 1000))

const openRun = (row: RunRow) => router.push({ path: `/flows/${row.flowId}`, query: { run: row.id } })
const source = computed(() => props.record.source)

const sourceLabel = computed(() => t(`source.${source.value.kind}`))
const sourceDetail = computed(() => {
  const s = source.value
  switch (s.kind) {
    case 'llm':
      return [
        [t('hover.provider'), s.provider],
        [t('hover.model'), s.model],
        [t('hover.latency'), `${s.latencyMs} ms`],
        ...(s.tokens !== undefined ? [[t('hover.tokens'), String(s.tokens)]] : []),
        ...(s.persona ? [[t('hover.persona'), s.persona]] : []),
        ...(s.plugin ? [[t('hover.viaPlugin'), s.plugin]] : []),
      ]
    case 'plugin':
      return [[t('hover.plugin'), s.plugin]]
    case 'flow':
      return [
        [t('hover.flow'), s.flow],
        [t('hover.node'), s.node],
        ...(s.model ? [[t('hover.provider'), s.provider ?? ''], [t('hover.model'), s.model]] : []),
        ...(s.persona ? [[t('hover.persona'), s.persona]] : []),
      ]
    case 'agent':
      return [[t('hover.session'), s.session]]
    default:
      return []
  }
})

/** Knowledge base passages a flow reply was written from. */
const knowledge = computed(() => (source.value.kind === 'flow' ? source.value.knowledge ?? [] : []))

const typeLabel = computed(() => (te(`messageType.${props.record.type}`) ? t(`messageType.${props.record.type}`) : props.record.type))

/** A message that is only an image, video, card or forward shows without the bubble around it, as in QQ. */
const BLOCKS = new Set(['image', 'mface', 'video', 'forward', 'node', 'json', 'file'])
const bare = computed(() => {
  const shown = props.record.segments.filter((segment) => segment.type !== 'reply')
  if (!shown.length) return false
  if (shown.every((segment) => segment.type === 'node')) return true
  return shown.length === 1 && BLOCKS.has(shown[0].type)
})
</script>

<template>
  <div class="row" :class="{ out: outgoing }">
    <Avatar class="avatar" :src="avatar" :size="34" :color="avatarColor(record.user.id)">{{ initial(who) }}</Avatar>
    <div class="body">
      <div class="meta">
        <span class="who">{{ who }}</span>
        <span class="time">{{ formatTime(record.timestamp) }}</span>
      </div>
      <Popover
        :show="open"
        :placement="outgoing ? 'left' : 'right'"
        align="start"
        keep-focus
        :style="{ maxWidth: '320px' }"
        @update:show="(value: boolean) => { if (!value) open = false }"
        @mouseenter="show"
        @mouseleave="hide()"
      >
        <template #trigger>
          <div
            class="bubble"
            :class="[`source-${source.kind}`, { bare }]"
            tabindex="0"
            :data-message-id="record.id"
            @mouseenter="show"
            @mouseleave="hide()"
            @focus="show"
            @blur="hide(0)"
          >
            <MessageContent :segments="record.segments" :bot-id="record.botId" :channel="record.channel" />
          </div>
        </template>
        <dl class="info">
          <dt>{{ t('hover.type') }}</dt>
          <dd>{{ typeLabel }}</dd>
          <dt>{{ t('hover.platforms') }}</dt>
          <dd>
            <template v-if="record.platforms.length">
              <Tag v-for="platform in record.platforms" :key="platform" size="tiny">{{ platform }}</Tag>
            </template>
            <span v-else>{{ t('hover.noPlatform') }}</span>
          </dd>
          <dt>{{ t('hover.source') }}</dt>
          <dd>
            <Tag size="tiny" :type="source.kind === 'llm' ? 'info' : source.kind === 'plugin' ? 'success' : 'default'">
              {{ sourceLabel }}
            </Tag>
          </dd>
          <template v-for="[key, value] in sourceDetail" :key="key">
            <dt class="sub">{{ key }}</dt>
            <dd class="mono">{{ value }}</dd>
          </template>
          <template v-if="knowledge.length">
            <dt>{{ t('hover.knowledge') }}</dt>
            <dd class="sources">
              <RouterLink v-for="(item, index) in knowledge" :key="item.chunk" :to="`/knowledge/${item.base}/chunks?doc=${item.doc}&chunk=${item.chunk}`">[{{ index + 1 }}] {{ item.title }}</RouterLink>
            </dd>
          </template>
        </dl>
        <template v-if="cost !== undefined">
          <div class="section-title">
            {{ t('usage.title') }}
            <span v-if="cost?.events.length" class="total">{{ t('usage.total', { n: tokensOf(cost.events) }) }}</span>
          </div>
          <p v-if="cost === null" class="muted-line">{{ t('usage.unknown') }}</p>
          <template v-else>
            <ul v-if="cost.events.length" class="costs">
              <li v-for="(event, index) in cost.events" :key="index" :class="{ failed: event.ok === false }">
                <Tag size="tiny" :type="event.ok === false ? 'error' : 'default'">{{ kindLabel(event.kind) }}</Tag>
                <span class="cost-what" :title="[event.provider, event.model, event.plugin].filter(Boolean).join(' · ')">{{ event.model ?? event.note ?? shortPlugin(event.plugin) }}</span>
                <span class="cost-num">
                  <template v-if="event.ok === false">{{ t('usage.failed') }}</template>
                  <template v-else-if="event.inputTokens !== undefined || event.outputTokens !== undefined">{{ t('usage.tokens', { input: event.inputTokens ?? 0, output: event.outputTokens ?? 0 }) }}</template>
                  <template v-if="event.latencyMs !== undefined"> · {{ event.latencyMs }} ms</template>
                </span>
              </li>
            </ul>
            <p v-else-if="!outgoing" class="muted-line">{{ t('usage.none') }}</p>
            <dl class="info transfer">
              <template v-if="outgoing && cost.bytes !== undefined && cost.sendMs !== undefined">
                <dt>{{ t('usage.send') }}</dt>
                <dd class="mono">{{ t('usage.sendDetail', { size: formatBytes(cost.bytes), ms: cost.sendMs, speed: speed(cost.bytes, cost.sendMs) }) }}</dd>
              </template>
              <template v-else-if="cost.bytes !== undefined">
                <dt>{{ t('usage.size') }}</dt>
                <dd class="mono">{{ formatBytes(cost.bytes) }}</dd>
              </template>
            </dl>
            <p v-if="cost.causeEvents?.length" class="muted-line">{{ t('usage.cause', { n: tokensOf(cost.causeEvents), count: cost.causeEvents.length }) }}</p>
          </template>
        </template>
        <template v-if="!outgoing">
          <div class="section-title">{{ t('live.runs') }}</div>
          <p v-if="runsError" class="muted-line">{{ t('live.runsUnavailable') }}</p>
          <p v-else-if="!runs && loadingRuns" class="muted-line">{{ t('live.runsLoading') }}</p>
          <p v-else-if="!runs?.length" class="muted-line">{{ t('live.noRuns') }}</p>
          <ul v-else class="runs">
            <li v-for="row in runs" :key="row.id">
              <button type="button" class="run" :title="row.error" @click="openRun(row)">
                <span class="run-name">{{ row.flowName }}</span>
                <Tag size="tiny" :type="row.status === 'ok' ? 'success' : row.status === 'error' ? 'error' : 'default'">{{ t(`runs.status.${row.status}`) }}</Tag>
                <span class="run-time">{{ formatTime(row.startedAt) }}</span>
              </button>
            </li>
          </ul>
          <div class="actions">
            <button type="button" class="link" @click="open = false; emit('newFlow')">
              <span class="i-lucide-network" />{{ t('live.actionNewFlow') }}
            </button>
            <button type="button" class="link" @click="open = false; emit('quote')">
              <span class="i-lucide-quote" />{{ t('live.actionAgent') }}
            </button>
          </div>
        </template>
      </Popover>
    </div>
  </div>
</template>

<style scoped>
.sources {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: 100%;
}

.row.out {
  flex-direction: row-reverse;
}

.avatar {
  margin-top: 2px;
}

.body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.out .body {
  align-items: flex-end;
}

.section-title {
  margin: 12px 0 6px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  opacity: 0.6;
}

.total {
  float: right;
  font-family: var(--mono, monospace);
}

.costs {
  list-style: none;
  margin: 0 0 6px;
  padding: 0;
  display: grid;
  gap: 4px;
  font-size: 13px;
}

.costs li {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cost-what {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}

.cost-num {
  font-size: 12px;
  opacity: 0.7;
  white-space: nowrap;
}

.transfer {
  margin-top: 4px;
}

.muted-line {
  margin: 0;
  font-size: 13px;
  opacity: 0.6;
}

.runs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
}

.run {
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

.run:hover,
.run:focus-visible {
  background: var(--s2);
}

.run-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-time {
  font-size: 12px;
  opacity: 0.55;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  border: none;
  background: transparent;
  color: var(--primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.link:hover {
  text-decoration: underline;
}

.meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  opacity: 0.6;
}

.bubble {
  max-width: min(520px, 85%);
  padding: 8px 12px;
  border-radius: 12px;
  border-top-left-radius: 4px;
  background: var(--s3);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  cursor: default;
  outline: none;
  border: 1px solid transparent;
}

.out .bubble {
  border-top-left-radius: 12px;
  border-top-right-radius: 4px;
  background: var(--primary-soft);
}

.bubble:hover,
.bubble:focus-visible {
  border-color: var(--primary);
}

.bubble.bare,
.out .bubble.bare {
  padding: 0;
  background: transparent;
}

.out .bubble.source-llm {
  background: var(--info-soft);
}

.out .bubble.source-plugin {
  background: var(--ok-soft);
}

.info {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  margin: 0;
  font-size: 13px;
  align-items: center;
}

.info dt {
  opacity: 0.6;
}

.info dt.sub {
  padding-left: 10px;
}

.info dd {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
