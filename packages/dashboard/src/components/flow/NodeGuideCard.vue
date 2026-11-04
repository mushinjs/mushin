<script setup lang="ts">
/**
 * A node type's tutorial, shown beside the node list while a node is hovered. It replays the
 * type's example flow as it really ran (the server ran it as a test), drawn like the canvas: node
 * cards with their settings and branches, wires between them. A light runs along each wire the run
 * took, each node shows a check when it finishes and what it produced pops out of its output, and
 * the conversation plays below. Types without an example show their inputs, outputs and branches.
 * With reduced motion the finished run shows at once, with every caption listed.
 */
import { CheckmarkOutline } from '@vicons/ionicons5'
import { NIcon, useThemeVars } from 'naive-ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { categoryColors, configSummary, portsOf, schemaDefaults, wholeRef } from '../../flow'
import type { NodeTypeInfo, PortDef } from '../../types'
import { useTheme } from '../../theme'
import { localize } from '../../utils'
import { type GuidePass, type GuideRun, guideRun } from './guide'
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
const { isDark } = useTheme()

const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

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
const portTitle = (port: PortDef | undefined, name: string) => (port ? localize(port.title, locale.value) || port.name : name)

// ---- the example's nodes, drawn as small canvas cards ----

const NODE_W = 138
const HEAD_H = 28
const ROW_H = 17
const PAD = 5
const COL_GAP = 46
const ROW_GAP = 26
const MAX_W = 432

interface MiniNode {
  id: string
  type: string
  title: string
  category: NodeTypeInfo['category']
  rows: { key: string; label: string; value: string; ref?: { node: string; name: string } }[]
  /** Exec outputs shown as rows; empty when the node only goes on to `next`. */
  branches: string[]
  x: number
  y: number
  h: number
}

const nodes = computed<MiniNode[]>(() => {
  const value = run.value
  if (!value) return []
  // Columns by distance from the trigger, like the canvas reads left to right.
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
  const built = value.nodes.map((node) => {
    const type = typeOf(node.type)
    const config = { ...schemaDefaults(type?.configSchema), ...node.config }
    const ports = type ? portsOf(type, config) : undefined
    const execOut = ports?.execOut ?? ['next']
    const inputRows = Object.entries(node.inputs ?? {}).map(([name, binding]) => {
      const ref = wholeRef(binding)
      return { key: `in-${name}`, label: portTitle(type?.inputs.find((port) => port.name === name), name), value: binding, ...(ref ? { ref: { node: ref.head, name: ref.name } } : {}) }
    })
    const summary = type ? configSummary(type, node.config, locale.value, 2) : []
    return {
      id: node.id,
      type: node.type,
      title: localize(type?.title, locale.value) || node.type,
      category: type?.category ?? 'logic',
      rows: [...inputRows, ...summary].slice(0, 2),
      branches: execOut.length === 1 && execOut[0] === 'next' ? [] : execOut,
      x: 0,
      y: 0,
      h: 0,
      col: depth.get(node.id) ?? 0,
    }
  })
  const columns: (typeof built)[] = []
  for (const node of built) (columns[node.col] ??= []).push(node)
  for (const node of built) {
    node.h = HEAD_H + (node.rows.length ? node.rows.length * ROW_H + PAD : 0) + (node.branches.length ? node.branches.length * ROW_H + PAD : 0)
  }
  const heights = columns.map((column) => column.reduce((sum, node) => sum + node.h, 0) + (column.length - 1) * ROW_GAP)
  const tallest = Math.max(...heights)
  columns.forEach((column, col) => {
    let y = (tallest - heights[col]) / 2
    for (const node of column) {
      node.x = col * (NODE_W + COL_GAP)
      node.y = y
      y += node.h + ROW_GAP
    }
  })
  return built
})

const nodeById = computed(() => new Map(nodes.value.map((node) => [node.id, node])))

const size = computed(() => {
  const width = Math.max(...nodes.value.map((node) => node.x + NODE_W), NODE_W) + 12
  const height = Math.max(...nodes.value.map((node) => node.y + node.h), HEAD_H) + 24
  return { width, height, scale: Math.min(1, MAX_W / width) }
})

/** Where an exec output leaves a node: its header, or its branch row. */
function outPoint(node: MiniNode, exec: string) {
  const index = node.branches.indexOf(exec)
  if (index < 0) return { x: node.x + NODE_W, y: node.y + HEAD_H / 2 }
  const top = node.y + HEAD_H + (node.rows.length ? node.rows.length * ROW_H + PAD : 0)
  return { x: node.x + NODE_W, y: top + index * ROW_H + ROW_H / 2 }
}

const wires = computed(() => (run.value?.edges ?? []).map(([from, to, exec = 'next']) => {
  const a = outPoint(nodeById.value.get(from)!, exec)
  const target = nodeById.value.get(to)!
  const b = { x: target.x, y: target.y + HEAD_H / 2 }
  const bend = Math.max(18, (b.x - a.x) / 2)
  return { key: `${from}>${to}:${exec}`, from, to, exec, d: `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}` }
}))

// ---- playback: each message runs on the mini canvas while the chat below fills in ----

const RUN_MS = 600
const SHOW_MS = 450
const TRAVEL_MS = 420
const START_MS = 700
const BETWEEN_MS = 1100
const HOLD_MS = 2600

const running = ref<string>()
const done = ref(new Set<string>())
const lit = ref(new Set<string>())
const travelling = ref<string>()
/** Which message is playing, how many chat lines show, and which caption. */
const beat = ref(0)
const said = ref(0)
const step = ref(-1)
const finished = ref(false)

const focus = computed(() => run.value?.nodes.find((node) => node.type === props.type.type))
const focusConfig = computed(() => ({ ...schemaDefaults(props.type.configSchema), ...focus.value?.config }))
const passes = computed<GuidePass[]>(() => run.value?.passes ?? (run.value ? [run.value] : []))
const current = computed(() => passes.value[beat.value] ?? passes.value[0])
/** With several messages a caption goes with each message, else with each step. */
const perMessage = computed(() => passes.value.length > 1)

let generation = 0
const sleep = (ms: number, mine: number) => new Promise<boolean>((resolve) => setTimeout(() => resolve(mine === generation), ms))

function resetCanvas() {
  running.value = undefined
  done.value = new Set()
  lit.value = new Set()
  travelling.value = undefined
}

const valueText = (value: unknown) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value))
const clip = (value: unknown, max = 16) => {
  const text = valueText(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** What the explained node did with this message, in words, for the line between the bubbles. */
function noteOf(item: GuidePass, index: number): string | undefined {
  const entry = item.steps.find((each) => each.nodeId === focus.value?.id)
  if (!entry) return
  if (entry.error) return entry.error
  const config = focusConfig.value
  const out = entry.outputs ?? {}
  const exec = entry.exec ?? 'next'
  const earlier = (passes.value[index - 1]?.steps.find((each) => each.nodeId === focus.value?.id)?.outputs ?? {}) as Record<string, unknown>
  switch (props.type.type) {
    case 'logic.if': return t('flows.note.if', { value: valueText(entry.inputs?.condition), exec })
    case 'logic.compare': return t('flows.note.compare', { a: clip(entry.inputs?.a, 12), op: t(`flows.note.op.${config.op}`), b: clip(entry.inputs?.b ?? config.value, 10), exec })
    case 'logic.random': return t('flows.note.random', { exec, percent: exec === 'yes' ? config.percent : 100 - Number(config.percent) })
    case 'logic.cooldown': return exec === 'ready' ? t('flows.note.cooldownReady', { n: config.seconds }) : t('flows.note.cooldownCooling', { n: config.seconds })
    case 'logic.rateLimit': return exec === 'ok'
      ? t('flows.note.rateOk', { used: Number(config.limit) - Number(out.remaining ?? 0), limit: config.limit, n: config.seconds })
      : t('flows.note.rateLimited', { limit: config.limit, retry: out.retryAfter })
    case 'logic.dailyQuota': return exec === 'ok' ? t('flows.note.quotaOk', { used: out.used, limit: config.times }) : t('flows.note.quotaOut', { limit: config.times })
    case 'logic.delay': return t('flows.note.delay', { n: config.seconds })
    case 'logic.waitReply': return exec === 'reply' ? t('flows.note.waitReply', { text: clip(out.text) }) : t('flows.note.waitTimeout', { n: config.seconds })
    case 'logic.permission': return exec === 'allow' ? t('flows.note.allowed', { role: t(`flows.note.role.${valueText(out.role) || 'user'}`) }) : t('flows.note.denied', { reason: valueText(out.reason) })
    case 'ai.classify': return t('flows.note.classify', { label: valueText(out.label) || exec })
    case 'data.increment': return t('flows.note.increment', { name: config.name, from: valueText(earlier.value ?? Number(out.value ?? 0) - Number(config.by ?? 1)), to: valueText(out.value) })
    case 'data.setVar': return t('flows.note.setVar', { name: config.name, value: clip(entry.inputs?.value ?? config.value) })
    case 'data.getVar': return t('flows.note.getVar', { name: config.name, value: clip(out.value) })
  }
  if (exec !== 'next') return `→ ${exec}`
}

interface ChatLine { who: 'user' | 'bot' | 'note'; text: string; pass: number; after: number }

/** Every message of the example and what came back, each line with the step it appears after. */
const chat = computed<ChatLine[]>(() => {
  const value = run.value
  if (!value) return []
  const lines: ChatLine[] = []
  passes.value.forEach((item, pass) => {
    lines.push({ who: 'user', text: item.input.text, pass, after: -1 })
    const replies = [...item.replies]
    const waits = pass === 0 ? [...value.waits] : []
    item.steps.forEach((entry, index) => {
      const type = value.nodes.find((node) => node.id === entry.nodeId)?.type
      if (entry.nodeId === focus.value?.id && type !== 'trigger.message' && type?.startsWith('trigger.') === false) {
        const note = noteOf(item, pass)
        if (note) lines.push({ who: 'note', text: note, pass, after: index })
      }
      if (type === 'logic.waitReply' && entry.exec === 'reply' && waits.length) lines.push({ who: 'user', text: waits.shift()!, pass, after: index })
      if ((type === 'action.reply' || type === 'action.send') && !entry.error && replies.length) lines.push({ who: 'bot', text: replies.shift()!, pass, after: index })
    })
    // A message that ends without a reply still says so, so silence reads as part of the example.
    if (!item.replies.length) lines.push({ who: 'note', text: t('flows.note.silent'), pass, after: item.steps.length - 1 })
  })
  return lines
})
const saidUpTo = (pass: number, index: number) => chat.value.filter((line) => line.pass < pass || (line.pass === pass && line.after <= index)).length

/** The wire the run took out of step `index`, to the next step. */
function wireAfter(index: number) {
  const steps = current.value?.steps ?? []
  const from = steps[index]
  const to = steps[index + 1]
  if (!from || !to) return
  return wires.value.find((wire) => wire.from === from.nodeId && wire.to === to.nodeId && wire.exec === (from.exec ?? 'next'))
}

const chatBox = ref<HTMLElement>()
watch(said, () => nextTick(() => chatBox.value?.scrollTo({ top: chatBox.value.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })))

async function play(mine: number) {
  while (mine === generation) {
    said.value = 0
    finished.value = false
    for (let pass = 0; pass < passes.value.length; pass++) {
      beat.value = pass
      // The first message shows each step; the ones after it play quicker, the point is how they end.
      const pace = pass === 0 ? 1 : 0.55
      resetCanvas()
      step.value = perMessage.value ? pass : -1
      said.value = saidUpTo(pass, -1)
      if (!await sleep(START_MS * pace, mine)) return
      const steps = current.value?.steps ?? []
      for (let index = 0; index < steps.length; index++) {
        if (!perMessage.value) step.value = index
        running.value = steps[index].nodeId
        if (!await sleep(RUN_MS * pace, mine)) return
        running.value = undefined
        done.value = new Set([...done.value, steps[index].nodeId])
        said.value = saidUpTo(pass, index)
        if (!await sleep(SHOW_MS * pace, mine)) return
        const wire = wireAfter(index)
        if (wire) {
          travelling.value = wire.key
          if (!await sleep(TRAVEL_MS * pace, mine)) return
          travelling.value = undefined
          lit.value = new Set([...lit.value, wire.key])
        }
      }
      said.value = saidUpTo(pass, Infinity)
      if (pass < passes.value.length - 1 && !await sleep(BETWEEN_MS, mine)) return
    }
    finished.value = true
    if (!await sleep(HOLD_MS, mine)) return
  }
}

function showAll() {
  beat.value = passes.value.length - 1
  resetCanvas()
  const steps = current.value?.steps ?? []
  done.value = new Set(steps.map((item) => item.nodeId))
  lit.value = new Set(steps.map((_, index) => wireAfter(index)?.key).filter((key): key is string => !!key))
  said.value = chat.value.length
  step.value = perMessage.value ? beat.value : steps.length - 1
  finished.value = true
}

watch(run, (value) => {
  generation++
  beat.value = 0
  said.value = 0
  if (!value) return resetCanvas()
  if (reduced) showAll()
  else void play(generation)
}, { immediate: true })
onBeforeUnmount(() => generation++)

const stepOf = (id: string) => current.value?.steps.find((item) => item.nodeId === id)
const SESSION_KEYS = new Set(['text', 'userName', 'userId', 'command', 'args', 'isPrivate', 'message', 'messageId', 'groupId', 'mentioned', 'role', 'tokens', 'model', 'sent', 'first', 'retryAfter'])

/** The most telling value a node produced, for the chip at its output; nothing for plain sends. */
function producedBy(node: MiniNode) {
  const item = stepOf(node.id)
  if (!item) return
  if (item.error) return { label: '!', value: item.error, error: true }
  const type = typeOf(node.type)
  const entries = Object.entries(item.outputs ?? {}).filter(([, value]) => value !== '' && value !== undefined && value !== null)
  const picked = entries.find(([key]) => !SESSION_KEYS.has(key)) ?? (type?.kind === 'trigger' ? entries.find(([key]) => key === 'text') : undefined)
  if (!picked) return
  const port = type?.outputs.find((output) => output.name === picked[0])
  const raw = typeof picked[1] === 'string' ? picked[1] : JSON.stringify(picked[1])
  return { label: portTitle(port, picked[0]), value: raw.length > 18 ? `${raw.slice(0, 17)}…` : raw, error: false }
}

const takenBranch = (node: MiniNode) => (done.value.has(node.id) ? stepOf(node.id)?.exec : undefined)
const travelPath = computed(() => wires.value.find((wire) => wire.key === travelling.value)?.d)

const captions = computed(() => (props.type.guide?.captions ?? []).map((text) => localize(text, locale.value)))
const caption = computed(() => (step.value < 0 ? t('flows.guideIncoming') : captions.value[step.value] ?? ''))
const total = computed(() => (perMessage.value ? passes.value.length : current.value?.steps.length ?? 0))

// ---- the card without an example: ports and branches ----

const portNames = (ports: PortDef[]) => ports.map((port) => localize(port.title, locale.value) || port.name)
const fallback = computed(() => ({
  inputs: portNames(props.type.inputs),
  outputs: portNames(props.type.outputs),
  branches: props.type.execOutFrom ? [] : props.type.execOut.filter((name) => name !== 'next'),
  fromConfig: !!props.type.execOutFrom,
}))

// ---- placement ----

const WIDTH = 460
// The card's real height keeps it inside the window as it grows and shrinks with the example.
const card = ref<HTMLElement>()
const height = ref(420)
let observer: ResizeObserver | undefined
onMounted(() => {
  if (!card.value || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(() => (height.value = card.value?.offsetHeight ?? height.value))
  observer.observe(card.value)
})
onBeforeUnmount(() => observer?.disconnect())
const style = computed(() => {
  const width = Math.min(WIDTH, window.innerWidth - 16)
  const side = props.beside ?? props.anchor
  const left = side.right + 8 + width <= window.innerWidth - 8 ? side.right + 8 : Math.max(8, side.left - 8 - width)
  const top = Math.max(8, Math.min(props.anchor.top - 12, window.innerHeight - height.value - 8))
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    background: theme.value.popoverColor,
    color: theme.value.textColor2,
    '--accent': categoryColors[props.type.category],
    // Teleported out of the editor, so its node colours are set here, for light and dark.
    '--accent-fg': `color-mix(in srgb, ${categoryColors[props.type.category]} ${isDark.value ? '62%' : '100%'}, ${theme.value.textColor1})`,
    '--accent-strength': isDark.value ? '62%' : '100%',
    '--flow-node-bg': isDark.value ? '#26262c' : '#fff',
    '--flow-node-fg': theme.value.textColor1,
  }
})
</script>

<template>
  <Teleport to="body">
    <div ref="card" class="guide-card" :style="style" role="tooltip" @mouseenter="emit('enter')" @mouseleave="emit('leave')">
      <header class="head">
        <span class="icon"><NIcon :size="15"><component :is="nodeIcon(type.type, type.category)" /></NIcon></span>
        <span class="title">{{ localize(type.title, locale) }}</span>
      </header>
      <p v-if="type.description" class="description">{{ localize(type.description, locale) }}</p>

      <template v-if="run && nodes.length">
        <div class="canvas" :style="{ height: `${size.height * size.scale + 16}px` }">
          <div class="stage" :style="{ width: `${size.width}px`, height: `${size.height}px`, transform: `scale(${size.scale})` }">
            <svg class="wires" :width="size.width" :height="size.height" aria-hidden="true">
              <path v-for="wire in wires" :key="wire.key" :d="wire.d" class="wire" :class="{ lit: lit.has(wire.key) }" />
            </svg>
            <span v-if="travelPath" :key="travelling" class="spark" :style="{ offsetPath: `path('${travelPath}')`, animationDuration: `${TRAVEL_MS * (beat === 0 ? 1 : 0.55)}ms` }" />
            <div
              v-for="node in nodes"
              :key="node.id"
              class="mini"
              :class="{ focus: node.type === type.type, running: running === node.id, done: done.has(node.id), missed: finished && !stepOf(node.id) }"
              :style="{ left: `${node.x}px`, top: `${node.y}px`, width: `${NODE_W}px`, height: `${node.h}px`, '--node-accent': categoryColors[node.category] }"
            >
              <span v-if="node.id !== nodes[0].id" class="port-in" />
              <div class="mini-head">
                <span class="mini-icon"><NIcon :size="11"><component :is="nodeIcon(node.type, node.category)" /></NIcon></span>
                <span class="mini-title">{{ node.title }}</span>
                <span v-if="done.has(node.id) && !stepOf(node.id)?.error" class="check"><NIcon :size="9"><CheckmarkOutline /></NIcon></span>
                <span v-if="!node.branches.length" class="port-out" :class="{ on: done.has(node.id) }" />
              </div>
              <div v-if="node.rows.length" class="mini-rows">
                <div v-for="row in node.rows" :key="row.key" class="mini-row">
                  <span class="mini-label">{{ row.label }}</span>
                  <span v-if="row.ref" class="var-chip">{{ row.ref.node }}<span class="var-sep">/</span>{{ row.ref.name }}</span>
                  <span v-else class="mini-value">{{ row.value }}</span>
                </div>
              </div>
              <div v-if="node.branches.length" class="mini-branches">
                <div v-for="name in node.branches" :key="name" class="mini-branch" :class="{ taken: takenBranch(node) === name }">
                  <span>{{ name }}</span>
                  <span class="port-out" :class="{ on: takenBranch(node) === name }" />
                </div>
              </div>
              <Transition name="pop">
                <span v-if="done.has(node.id) && producedBy(node)" class="produced" :class="{ error: producedBy(node)!.error }">
                  <span class="produced-label">{{ producedBy(node)!.label }}</span>{{ producedBy(node)!.value }}
                </span>
              </Transition>
            </div>
          </div>
        </div>

        <div ref="chatBox" class="chat">
          <TransitionGroup name="bubble">
            <div v-for="(line, index) in chat.slice(0, said)" :key="index" :class="line.who === 'note' ? 'note' : ['bubble', line.who]">
              <template v-if="line.who === 'note'">
                <NIcon :size="11"><component :is="nodeIcon(type.type, type.category)" /></NIcon>
                <span>{{ line.text }}</span>
              </template>
              <template v-else>
                <span class="who">{{ line.who === 'user' ? passes[line.pass]?.input.userName : t('flows.guideBot') }}</span>
                <span class="said">{{ line.text }}</span>
              </template>
            </div>
          </TransitionGroup>
        </div>

        <ol v-if="reduced && captions.length" class="captions">
          <li v-for="(text, index) in captions" :key="index">{{ text }}</li>
        </ol>
        <div v-else class="caption-row">
          <span class="counter">{{ Math.max(step + 1, 0) }}/{{ total }}</span>
          <Transition name="caption" mode="out-in">
            <span :key="caption" class="caption">{{ caption }}</span>
          </Transition>
        </div>
      </template>
      <p v-else-if="loading" class="muted small">{{ t('flows.guideLoading') }}</p>
      <div v-else class="ports">
        <div v-if="fallback.inputs.length" class="port-row">
          <span class="port-label">{{ t('flows.guideInputs') }}</span>
          <span v-for="name in fallback.inputs" :key="name" class="port">{{ name }}</span>
        </div>
        <div v-if="fallback.outputs.length" class="port-row">
          <span class="port-label">{{ t('flows.guideOutputs') }}</span>
          <span v-for="name in fallback.outputs" :key="name" class="port">{{ name }}</span>
        </div>
        <div v-if="fallback.branches.length || fallback.fromConfig" class="port-row">
          <span class="port-label">{{ t('flows.guideBranches') }}</span>
          <span v-for="name in fallback.branches" :key="name" class="port branch">{{ name }}</span>
          <span v-if="fallback.fromConfig" class="muted">{{ t('flows.guideBranchesFromConfig') }}</span>
        </div>
      </div>
      <p class="foot muted">{{ t('flows.guideAdd') }}</p>
    </div>
  </Teleport>
</template>

<style scoped>
.guide-card {
  position: fixed;
  z-index: 3000;
  box-sizing: border-box;
  padding: 12px 14px 10px;
  border-radius: 12px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.2);
  font-size: 12px;
  line-height: 1.5;
  animation: card-in 0.18s ease-out;
}

@keyframes card-in {
  from { opacity: 0; transform: translateY(4px); }
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.icon {
  display: inline-flex;
  padding: 4px;
  border-radius: 7px;
  color: var(--accent-fg);
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}

.title {
  font-size: 14px;
  font-weight: 600;
}

.description {
  margin: 6px 0 10px;
  opacity: 0.75;
}

/* A dotted patch of canvas, like the editor's background. */
.canvas {
  position: relative;
  margin-top: 8px;
  overflow: hidden;
  border-radius: 10px;
  padding: 8px;
  box-sizing: border-box;
  background-color: rgba(127, 127, 127, 0.06);
  background-image: radial-gradient(rgba(127, 127, 127, 0.35) 1px, transparent 1.2px);
  background-size: 14px 14px;
}

.stage {
  position: relative;
  transform-origin: top left;
  margin-top: 4px;
}

.wires {
  position: absolute;
  inset: 0;
  overflow: visible;
}

.wire {
  fill: none;
  stroke: rgba(127, 127, 127, 0.5);
  stroke-width: 1.5;
  transition: stroke 0.35s, stroke-width 0.35s;
}

.wire.lit {
  stroke: var(--primary, #18a058);
  stroke-width: 2;
}

/* The light that runs down a wire as the run moves on. */
.spark {
  position: absolute;
  left: 0;
  top: 0;
  width: 9px;
  height: 9px;
  margin: -4.5px 0 0 -4.5px;
  border-radius: 50%;
  background: var(--primary, #18a058);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary, #18a058) 25%, transparent), 0 0 10px var(--primary, #18a058);
  offset-rotate: 0deg;
  offset-anchor: center;
  animation: travel ease-in-out forwards;
  z-index: 3;
}

@keyframes travel {
  from { offset-distance: 0%; }
  to { offset-distance: 100%; }
}

.mini {
  position: absolute;
  box-sizing: border-box;
  border-radius: 8px;
  border: 1.5px solid rgba(127, 127, 127, 0.25);
  background: var(--flow-node-bg, #fff);
  color: var(--flow-node-fg, inherit);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  font-size: 10.5px;
  transition: border-color 0.3s, box-shadow 0.3s, opacity 0.4s, transform 0.3s;
}

.mini.focus {
  border-color: color-mix(in srgb, var(--node-accent) 70%, transparent);
}

.mini.running {
  border-color: var(--primary, #18a058);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--primary, #18a058) 20%, transparent), 0 4px 12px rgba(0, 0, 0, 0.12);
  transform: translateY(-1px);
}

.mini.done {
  border-color: var(--ok, #18a058);
}

.mini.missed {
  opacity: 0.4;
}

.mini-head {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 8px 0 7px;
  box-sizing: border-box;
}

.mini-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  border-radius: 5px;
  color: color-mix(in srgb, var(--node-accent) var(--accent-strength, 100%), var(--flow-node-fg));
  background: color-mix(in srgb, var(--node-accent) 15%, transparent);
}

.mini-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.check {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  color: #fff;
  background: var(--ok, #18a058);
  animation: pop-in 0.3s cubic-bezier(0.3, 1.6, 0.5, 1);
}

.mini-rows,
.mini-branches {
  padding: 0 7px 5px;
}

.mini-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 17px;
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.08);
  margin-bottom: 0;
}

.mini-row + .mini-row {
  margin-top: 0;
}

.mini-label {
  flex: none;
  opacity: 0.55;
  font-size: 9.5px;
}

.mini-value,
.var-chip {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.var-chip {
  padding: 0 4px;
  border-radius: 3px;
  font-size: 9.5px;
  color: #2080f0;
  background: rgba(32, 128, 240, 0.12);
}

.var-sep {
  opacity: 0.5;
  margin: 0 1px;
}

.mini-branch {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  height: 17px;
  padding-right: 6px;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  opacity: 0.6;
  border-radius: 4px;
  transition: background 0.3s, color 0.3s, opacity 0.3s;
}

.mini-branch.taken {
  opacity: 1;
  color: var(--primary, #18a058);
  background: color-mix(in srgb, var(--primary, #18a058) 12%, transparent);
}

/* Handles: the exec input on the left of the header, outputs on the right. */
.port-in,
.port-out {
  position: absolute;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #8c8c8c;
  border: 1.5px solid var(--flow-node-bg, #fff);
  box-sizing: content-box;
  transition: background 0.3s;
}

.port-in {
  left: -5px;
  top: 9.5px;
}

.mini-head .port-out {
  right: -5px;
  top: 9.5px;
}

.mini-branch .port-out {
  right: -12px;
  top: 3.5px;
}

.port-out.on {
  background: var(--primary, #18a058);
}

/* What the node produced, popping out of it. */
.produced {
  position: absolute;
  left: 50%;
  top: calc(100% + 4px);
  transform: translateX(-50%);
  display: inline-flex;
  gap: 4px;
  max-width: 170px;
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 10px;
  line-height: 15px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--primary, #18a058);
  background: var(--flow-node-bg, #fff);
  border: 1px solid color-mix(in srgb, var(--primary, #18a058) 40%, transparent);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
  z-index: 2;
}

.produced.error {
  color: var(--bad, #d03050);
  border-color: color-mix(in srgb, var(--bad, #d03050) 40%, transparent);
}

.produced-label {
  opacity: 0.6;
}

.pop-enter-active {
  transition: opacity 0.25s, transform 0.35s cubic-bezier(0.3, 1.6, 0.5, 1);
}

.pop-enter-from {
  opacity: 0;
  transform: translate(-50%, -6px) scale(0.85);
}

@keyframes pop-in {
  from { transform: scale(0); }
}

.guide-card {
  max-height: calc(100vh - 16px);
  overflow-y: auto;
}

.chat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  height: 168px;
  padding: 8px 10px;
  box-sizing: border-box;
  overflow-y: auto;
  scrollbar-width: none;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.06);
}

/* What the explained node did, between the bubbles, like a chat app's system line. */
.note {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 92%;
  padding: 1px 9px;
  border-radius: 10px;
  font-size: 11px;
  color: var(--accent-fg);
  background: color-mix(in srgb, var(--accent) 13%, transparent);
}

.bubble {
  max-width: 80%;
  padding: 4px 9px 5px;
  border-radius: 11px;
  font-size: 12px;
  word-break: break-word;
  white-space: pre-wrap;
}

.bubble.user {
  align-self: flex-start;
  border-bottom-left-radius: 3px;
  background: rgba(127, 127, 127, 0.14);
}

.bubble.bot {
  align-self: flex-end;
  border-bottom-right-radius: 3px;
  background: color-mix(in srgb, var(--primary, #18a058) 16%, transparent);
}

.who {
  display: block;
  font-size: 10px;
  opacity: 0.55;
}

.bubble-enter-active {
  transition: opacity 0.3s, transform 0.3s ease-out;
}

.bubble-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.caption-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 10px;
  min-height: 36px;
}

.counter {
  flex: none;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  opacity: 0.5;
}

.caption {
  font-size: 12.5px;
}

.caption-enter-active,
.caption-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.caption-enter-from {
  opacity: 0;
  transform: translateY(3px);
}

.caption-leave-to {
  opacity: 0;
}

.captions {
  margin: 10px 0 0;
  padding-left: 18px;
}

.ports {
  display: grid;
  gap: 6px;
  padding: 10px;
  border-radius: 10px;
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

.foot {
  margin: 8px 0 0;
  font-size: 11px;
}

.muted {
  opacity: 0.6;
}

@media (prefers-reduced-motion: reduce) {
  .guide-card,
  .check {
    animation: none;
  }

  .pop-enter-active,
  .bubble-enter-active,
  .caption-enter-active,
  .caption-leave-active,
  .mini,
  .wire {
    transition: none;
  }
}
</style>
