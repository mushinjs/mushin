<script setup lang="ts">
/**
 * A node type's tutorial, shown beside the node list while a node is hovered. It plays the
 * type's example flow as it really ran (the server ran it as a test): the message comes in, each
 * node lights up in turn with what it produced, and the bot's replies appear in a chat beside it.
 * Types without an example show their inputs, outputs and branches. With reduced motion the
 * finished run shows at once, with every caption listed.
 */
import { NIcon, useThemeVars } from 'naive-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { categoryColors } from '../../flow'
import type { NodeTypeInfo, PortDef } from '../../types'
import { localize } from '../../utils'
import { type GuideRun, guideRun } from './guide'
import { nodeIcon } from './icons'

const props = defineProps<{
  type: NodeTypeInfo
  /** Every node type, for the titles and icons of the example's other nodes. */
  types: NodeTypeInfo[]
  /** The hovered item, in viewport coordinates; the card goes beside it. */
  anchor: DOMRect
  /** The list the item is in: the card goes beside it rather than over it. */
  beside?: DOMRect
}>()
const emit = defineEmits<{ enter: []; leave: [] }>()
const { t, locale } = useI18n()
const theme = useThemeVars()

const WIDTH = 340
const STEP_MS = 1300
const START_MS = 900
const HOLD_MS = 2600

const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const run = ref<GuideRun | null>()
const loading = ref(false)
watch(() => props.type.type, async (type) => {
  run.value = undefined
  if (!props.type.guide?.example) {
    run.value = null
    return
  }
  loading.value = true
  const result = await guideRun(type)
  if (props.type.type === type) {
    run.value = result && result.steps.length ? result : null
    loading.value = false
  }
}, { immediate: true })

const typeOf = (id: string) => props.types.find((item) => item.type === id)

// ---- layout: top to bottom by depth from the trigger, side by side within a depth ----

const BOX_H = 30
const ROW_GAP = 36
const STAGE_W = 150

const layout = computed(() => {
  const value = run.value
  if (!value) return
  const depth = new Map<string, number>([[value.nodes[0].id, 0]])
  const queue = [value.nodes[0].id]
  while (queue.length) {
    const id = queue.shift()!
    for (const [from, to] of value.edges) {
      if (from === id && !depth.has(to)) {
        depth.set(to, depth.get(id)! + 1)
        queue.push(to)
      }
    }
  }
  const rows: string[][] = []
  for (const node of value.nodes) {
    const row = depth.get(node.id) ?? rows.length
    ;(rows[row] ??= []).push(node.id)
  }
  const boxes = new Map<string, { x: number; y: number; w: number }>()
  rows.forEach((ids, row) => {
    const w = Math.min(STAGE_W, (STAGE_W - (ids.length - 1) * 8) / ids.length)
    const total = ids.length * w + (ids.length - 1) * 8
    ids.forEach((id, index) => boxes.set(id, { x: (STAGE_W - total) / 2 + index * (w + 8), y: row * (BOX_H + ROW_GAP), w }))
  })
  return { boxes, height: rows.length * BOX_H + (rows.length - 1) * ROW_GAP }
})

const edgePaths = computed(() => {
  const value = run.value
  const boxes = layout.value?.boxes
  if (!value || !boxes) return []
  return value.edges.map(([from, to, exec = 'next']) => {
    const a = boxes.get(from)!
    const b = boxes.get(to)!
    const x1 = a.x + a.w / 2
    const y1 = a.y + BOX_H
    const x2 = b.x + b.w / 2
    const y2 = b.y
    const mid = (y1 + y2) / 2
    return {
      key: `${from}-${to}-${exec}`,
      from, to, exec,
      d: `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`,
      // Near the target, below the chip of what the source produced.
      labelX: x2,
      labelY: y2 - 5,
    }
  })
})

// ---- playback ----

/** -1 before anything, 0 when the message is in, i + 1 while step i runs, steps + 1 when done. */
const phase = ref(-1)
let timer: ReturnType<typeof setTimeout> | undefined
const hovering = ref(false)

function schedule(next: number, delay: number) {
  clearTimeout(timer)
  timer = setTimeout(() => {
    if (hovering.value && next < phase.value) return schedule(next, 400)
    phase.value = next
    tick()
  }, delay)
}

function tick() {
  const steps = run.value?.steps.length ?? 0
  if (phase.value <= steps) schedule(phase.value + 1, phase.value === 0 ? START_MS : STEP_MS)
  else schedule(0, HOLD_MS)
}

watch(run, (value) => {
  clearTimeout(timer)
  if (!value) return
  if (reduced) {
    phase.value = value.steps.length + 1
    return
  }
  phase.value = 0
  tick()
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(timer))

const stepIndex = (id: string) => run.value?.steps.findIndex((step) => step.nodeId === id) ?? -1
const visited = (id: string) => {
  const index = stepIndex(id)
  return index >= 0 && index < phase.value
}
const activeId = computed(() => run.value?.steps[phase.value - 1]?.nodeId)

/** The run went along this edge: its source ran, took this exec output, and its target ran after. */
function travelled(edge: { from: string; to: string; exec: string }) {
  const steps = run.value?.steps ?? []
  const a = stepIndex(edge.from)
  const b = stepIndex(edge.to)
  return a >= 0 && b > a && (steps[a].exec ?? 'next') === edge.exec && b < phase.value
}

const SESSION_KEYS = new Set(['text', 'userName', 'userId', 'command', 'args', 'isPrivate', 'message', 'messageId', 'groupId', 'mentioned', 'role', 'tokens', 'model', 'sent', 'first', 'retryAfter'])

/** The most telling thing a step produced, short; the branch it took shows on its edge. */
function chipOf(index: number) {
  const step = run.value?.steps[index]
  if (!step) return ''
  if (step.error) return step.error
  const node = run.value!.nodes.find((item) => item.id === step.nodeId)
  const type = node && typeOf(node.type)
  const entries = Object.entries(step.outputs ?? {}).filter(([key, value]) => value !== '' && value !== undefined && value !== null && !(SESSION_KEYS.has(key) && type?.kind === 'trigger'))
  const picked = entries.find(([key]) => !SESSION_KEYS.has(key)) ?? (type?.kind === 'trigger' ? undefined : entries.find(([key]) => key !== 'messageId'))
  if (!picked) return ''
  const port = type?.outputs.find((item) => item.name === picked[0])
  const label = port ? localize(port.title, locale.value) : picked[0]
  const value = typeof picked[1] === 'string' ? picked[1] : JSON.stringify(picked[1])
  const text = `${label}：${value}`
  return text.length > 26 ? `${text.slice(0, 25)}…` : text
}

/** The chat beside the graph, each line with the phase it appears at. */
const chat = computed(() => {
  const value = run.value
  if (!value) return []
  const lines: { who: 'user' | 'bot'; text: string; at: number }[] = [{ who: 'user', text: value.input.text, at: 0 }]
  const replies = [...value.replies]
  const waits = [...value.waits]
  value.steps.forEach((step, index) => {
    const type = value.nodes.find((node) => node.id === step.nodeId)?.type
    if ((type === 'action.reply' || type === 'action.send') && !step.error && replies.length) lines.push({ who: 'bot', text: replies.shift()!, at: index + 1 })
    if (type === 'logic.waitReply' && step.exec === 'reply' && waits.length) lines.push({ who: 'user', text: waits.shift()!, at: index + 1 })
  })
  return lines
})
const shownChat = computed(() => chat.value.filter((line) => line.at <= phase.value && phase.value >= 0))

const captions = computed(() => (props.type.guide?.captions ?? []).map((text) => localize(text, locale.value)))
const caption = computed(() => {
  if (phase.value <= 0) return run.value ? t('flows.guideIncoming') : ''
  return captions.value[phase.value - 1] ?? captions.value[captions.value.length - 1] ?? ''
})

// ---- the card without an example: ports and branches ----

const portNames = (ports: PortDef[]) => ports.map((port) => localize(port.title, locale.value) || port.name)
const fallback = computed(() => ({
  inputs: portNames(props.type.inputs),
  outputs: portNames(props.type.outputs),
  branches: props.type.execOutFrom ? [] : props.type.execOut.filter((name) => name !== 'next'),
  fromConfig: !!props.type.execOutFrom,
}))

// ---- placement ----

const style = computed(() => {
  const side = props.beside ?? props.anchor
  const left = side.right + 8 + WIDTH <= window.innerWidth - 8 ? side.right + 8 : Math.max(8, side.left - 8 - WIDTH)
  const top = Math.max(8, Math.min(props.anchor.top - 12, window.innerHeight - 380))
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${WIDTH}px`,
    background: theme.value.popoverColor,
    color: theme.value.textColor2,
    '--accent': categoryColors[props.type.category],
  }
})

const titleOf = (type: string) => localize(typeOf(type)?.title, locale.value) || type
</script>

<template>
  <Teleport to="body">
    <div
      class="guide-card"
      :style="style"
      role="tooltip"
      @mouseenter="hovering = true; emit('enter')"
      @mouseleave="hovering = false; emit('leave')"
    >
      <header class="head">
        <span class="icon"><NIcon :size="15"><component :is="nodeIcon(type.type, type.category)" /></NIcon></span>
        <span class="title">{{ localize(type.title, locale) }}</span>
      </header>
      <p v-if="type.description" class="description">{{ localize(type.description, locale) }}</p>

      <div v-if="run && layout" class="demo">
        <div class="stage" :style="{ width: `${STAGE_W}px`, height: `${layout.height + 18}px` }">
          <svg class="edges" :width="STAGE_W" :height="layout.height + 18" aria-hidden="true">
            <g v-for="edge in edgePaths" :key="edge.key">
              <path :d="edge.d" class="edge" :class="{ on: travelled(edge) }" />
              <text v-if="edge.exec !== 'next'" :x="edge.labelX" :y="edge.labelY" class="edge-label" :class="{ on: travelled(edge) }">{{ edge.exec }}</text>
            </g>
          </svg>
          <div
            v-for="node in run.nodes"
            :key="node.id"
            class="box"
            :class="{ focus: node.type === type.type, on: visited(node.id), active: activeId === node.id, missed: phase > run.steps.length && stepIndex(node.id) < 0 }"
            :style="{
              left: `${layout.boxes.get(node.id)!.x}px`,
              top: `${layout.boxes.get(node.id)!.y}px`,
              width: `${layout.boxes.get(node.id)!.w}px`,
              '--box-accent': categoryColors[typeOf(node.type)?.category ?? 'logic'],
            }"
          >
            <NIcon :size="11" class="box-icon"><component :is="nodeIcon(node.type, typeOf(node.type)?.category)" /></NIcon>
            <span class="box-title">{{ titleOf(node.type) }}</span>
            <span v-if="visited(node.id) && chipOf(stepIndex(node.id))" class="chip" :class="{ error: run.steps[stepIndex(node.id)]?.error }">{{ chipOf(stepIndex(node.id)) }}</span>
          </div>
        </div>
        <div class="chat" aria-live="off">
          <TransitionGroup name="bubble">
            <div v-for="(line, index) in shownChat" :key="index" class="bubble" :class="line.who">
              <span v-if="line.who === 'user' && index === 0" class="who">{{ run.input.userName }}</span>
              {{ line.text }}
            </div>
          </TransitionGroup>
        </div>
      </div>
      <p v-else-if="loading" class="muted small">{{ t('flows.guideLoading') }}</p>
      <div v-else class="ports">
        <div v-if="fallback.inputs.length" class="port-row">
          <span class="port-label">{{ t('flows.guideInputs') }}</span>
          <span v-for="name in fallback.inputs" :key="name" class="port in">{{ name }}</span>
        </div>
        <div class="flow-line" :class="{ still: reduced }" aria-hidden="true"><span class="dot" /></div>
        <div v-if="fallback.outputs.length" class="port-row">
          <span class="port-label">{{ t('flows.guideOutputs') }}</span>
          <span v-for="name in fallback.outputs" :key="name" class="port out">{{ name }}</span>
        </div>
        <div v-if="fallback.branches.length || fallback.fromConfig" class="port-row">
          <span class="port-label">{{ t('flows.guideBranches') }}</span>
          <span v-for="name in fallback.branches" :key="name" class="port branch">{{ name }}</span>
          <span v-if="fallback.fromConfig" class="muted small">{{ t('flows.guideBranchesFromConfig') }}</span>
        </div>
      </div>

      <ol v-if="run && reduced && captions.length" class="captions">
        <li v-for="(text, index) in captions" :key="index">{{ text }}</li>
      </ol>
      <Transition v-else-if="run" name="caption" mode="out-in">
        <p :key="caption" class="caption">{{ caption }}</p>
      </Transition>
      <p class="foot muted">{{ t('flows.guideAdd') }}</p>
    </div>
  </Teleport>
</template>

<style scoped>
.guide-card {
  position: fixed;
  z-index: 3000;
  padding: 12px 14px 10px;
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
  font-size: 12px;
  line-height: 1.5;
  animation: card-in 0.16s ease-out;
}

@keyframes card-in {
  from { opacity: 0; transform: translateY(4px); }
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.icon {
  display: inline-flex;
  padding: 4px;
  border-radius: 6px;
  color: var(--accent-fg, var(--accent));
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}

.title {
  font-size: 14px;
  font-weight: 600;
}

.description {
  margin: 6px 0 10px;
  opacity: 0.8;
}

.demo {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 10px;
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.07);
}

.stage {
  position: relative;
  flex: none;
}

.edges {
  position: absolute;
  inset: 0;
  overflow: visible;
}

.edge {
  fill: none;
  stroke: rgba(127, 127, 127, 0.45);
  stroke-width: 1.5;
  transition: stroke 0.3s;
}

.edge.on {
  stroke: var(--primary, #18a058);
  stroke-width: 2;
  stroke-dasharray: 5 3;
  animation: dash 0.6s linear infinite;
}

@keyframes dash {
  to { stroke-dashoffset: -8; }
}

.edge-label {
  font-size: 9px;
  text-anchor: middle;
  fill: currentColor;
  opacity: 0.55;
}

.edge-label.on {
  fill: var(--primary, #18a058);
  opacity: 1;
}

.box {
  position: absolute;
  box-sizing: border-box;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid rgba(127, 127, 127, 0.35);
  background: var(--flow-node-bg, rgba(127, 127, 127, 0.06));
  font-size: 11px;
  transition: border-color 0.3s, box-shadow 0.3s, opacity 0.3s;
}

.box.focus {
  border-color: var(--accent);
  border-width: 1.5px;
}

.box.on {
  border-color: var(--primary, #18a058);
}

.box.active {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary, #18a058) 30%, transparent);
  animation: pulse 0.9s ease-in-out infinite alternate;
}

.box.missed {
  opacity: 0.4;
}

@keyframes pulse {
  to { box-shadow: 0 0 0 5px color-mix(in srgb, var(--primary, #18a058) 12%, transparent); }
}

.box-icon {
  flex: none;
  color: var(--box-accent);
}

.box-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip {
  position: absolute;
  left: 50%;
  top: calc(100% + 2px);
  transform: translateX(-50%);
  max-width: 150px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--primary, #18a058);
  background: color-mix(in srgb, var(--primary, #18a058) 12%, transparent);
  z-index: 1;
  animation: chip-in 0.25s ease-out;
}

.chip.error {
  color: var(--error, #d03050);
  background: color-mix(in srgb, var(--error, #d03050) 12%, transparent);
}

@keyframes chip-in {
  from { opacity: 0; transform: translate(-50%, -3px); }
}

.chat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bubble {
  max-width: 100%;
  padding: 5px 8px;
  border-radius: 10px;
  font-size: 11.5px;
  word-break: break-word;
  white-space: pre-wrap;
}

.bubble.user {
  align-self: flex-start;
  border-bottom-left-radius: 3px;
  background: rgba(127, 127, 127, 0.16);
}

.bubble.bot {
  align-self: flex-end;
  border-bottom-right-radius: 3px;
  background: color-mix(in srgb, var(--primary, #18a058) 18%, transparent);
}

.who {
  display: block;
  font-size: 10px;
  opacity: 0.6;
}

.bubble-enter-active {
  transition: opacity 0.25s, transform 0.25s;
}

.bubble-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.caption {
  margin: 8px 0 0;
  min-height: 36px;
  font-size: 12px;
}

.caption-enter-active,
.caption-leave-active {
  transition: opacity 0.2s;
}

.caption-enter-from,
.caption-leave-to {
  opacity: 0;
}

.captions {
  margin: 8px 0 0;
  padding-left: 18px;
}

.ports {
  display: grid;
  gap: 6px;
  padding: 10px;
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.07);
}

.port-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.port-label {
  font-size: 11px;
  opacity: 0.6;
  margin-right: 2px;
}

.port {
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 18px;
  background: rgba(127, 127, 127, 0.14);
}

.port.branch {
  color: var(--primary, #18a058);
  background: color-mix(in srgb, var(--primary, #18a058) 12%, transparent);
}

.flow-line {
  position: relative;
  height: 2px;
  margin: 4px 0;
  background: rgba(127, 127, 127, 0.25);
  overflow: hidden;
}

.flow-line .dot {
  position: absolute;
  top: -2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: travel 1.6s ease-in-out infinite;
}

.flow-line.still .dot {
  animation: none;
  left: 50%;
}

@keyframes travel {
  from { left: 0; }
  to { left: calc(100% - 6px); }
}

.foot {
  margin: 8px 0 0;
  font-size: 11px;
}

.muted {
  opacity: 0.6;
}

@media (prefers-reduced-motion: reduce) {
  .guide-card,
  .chip,
  .box.active,
  .edge.on {
    animation: none;
  }

  .bubble-enter-active,
  .caption-enter-active,
  .caption-leave-active {
    transition: none;
  }
}
</style>
