<script setup lang="ts">
/**
 * What makes a logic node itself, acted out for one message of its tutorial: a junction for If, a
 * spinning wheel for Random, a timer ring for Cooldown, slots that fill up for Rate limit, and so
 * on. Every value comes from the example's real run. `beat` is the message, `stage` how far it got:
 * it arrives (`in`), the node decides (`decide`), the result shows (`out`).
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { GuidePass } from './guide'

export type SceneStage = 'in' | 'decide' | 'out'

const props = defineProps<{
  type: string
  /** The node's settings, defaults filled in. */
  config: Record<string, any>
  passes: GuidePass[]
  focusId: string
  beat: number
  stage: SceneStage
}>()
const { t } = useI18n()

const pass = computed(() => props.passes[props.beat] ?? props.passes[0])
const stepIn = (item: GuidePass | undefined) => item?.steps.find((step) => step.nodeId === props.focusId)
const step = computed(() => stepIn(pass.value))
const exec = computed(() => step.value?.exec ?? 'next')
const decided = computed(() => props.stage !== 'in')
const shown = computed(() => props.stage === 'out')
const text = (value: unknown) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value))
const short = (value: unknown, max = 14) => {
  const s = text(value)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Steps of this node in the messages so far, this one included once it is decided. */
const sofar = computed(() => props.passes.slice(0, props.beat + (decided.value ? 1 : 0)).map(stepIn))

// ---- If: the message rides a track that switches on the condition ----
const condition = computed(() => step.value?.inputs?.condition)
const ifPath = computed(() => (exec.value === 'true' ? 'M 16 52 L 120 52 C 160 52, 170 20, 220 20 L 290 20' : 'M 16 52 L 120 52 C 160 52, 170 84, 220 84 L 290 84'))
const ifDistance = computed(() => (props.stage === 'in' ? '0%' : props.stage === 'decide' ? '37%' : '100%'))

// ---- Compare: A, the operator, B and the answer ----
const OPS: Record<string, string> = { equals: '=', notEquals: '≠', greater: '>', less: '<' }
const op = computed(() => OPS[props.config.op] ?? t(`flows.scene.op.${props.config.op}`))
const a = computed(() => text(step.value?.inputs?.a))
const b = computed(() => text(step.value?.inputs?.b ?? props.config.value))
/** For contains and friends, the part of A that B matched, to mark it. */
const aParts = computed(() => {
  const at = ['contains', 'startsWith', 'endsWith'].includes(props.config.op) && b.value ? a.value.indexOf(b.value) : -1
  return at < 0 ? [{ text: a.value, hit: false }] : [
    { text: a.value.slice(0, at), hit: false },
    { text: b.value, hit: true },
    { text: a.value.slice(at + b.value.length), hit: false },
  ].filter((part) => part.text)
})

// ---- Random: a wheel with a yes slice, spun once per message ----
const percent = computed(() => Math.max(0, Math.min(100, Number(props.config.percent ?? 50))))
const R = 38
const CIRC = 2 * Math.PI * R
/** Where the wheel stops: whole turns per message, landing inside the slice that was drawn. */
function landing(index: number, value: string | undefined) {
  const yes = percent.value / 100
  const inside = value === 'yes' ? yes * (0.3 + ((index * 37) % 40) / 100) : yes + (1 - yes) * (0.3 + ((index * 53) % 40) / 100)
  return (index + 1) * 720 - inside * 360
}
const wheelTurn = computed(() => {
  const index = props.beat
  const settled = decided.value ? index : index - 1
  return settled < 0 ? 0 : landing(settled, stepIn(props.passes[settled])?.exec)
})

// ---- Cooldown: a ring that starts when a message passes ----
const seconds = computed(() => Number(props.config.seconds ?? 30))
const coolingStarted = computed(() => sofar.value.some((item) => item?.exec === 'ready'))

// ---- Rate limit and Daily quota: slots that fill up ----
const limit = computed(() => Number(props.type === 'logic.dailyQuota' ? props.config.times : props.config.limit) || 0)
const used = computed(() => sofar.value.filter((item) => item?.exec === 'ok').length)
const blocked = computed(() => decided.value && (exec.value === 'limited' || exec.value === 'exhausted'))

// ---- Permission: the sender's card, checked against the lists and the roles ----
const listed = computed(() => (props.config.blockUsers ?? []).includes(pass.value.input.userId))
const role = computed(() => text(step.value?.outputs?.role) || pass.value.input.role || 'user')
const allowed = computed(() => (props.config.allow ?? []) as string[])
const roleOk = computed(() => exec.value === 'allow')
const checks = computed(() => [
  { key: 'list', label: t('flows.scene.notBlocked'), ok: !listed.value },
  { key: 'role', label: t('flows.scene.roleNeeded', { roles: allowed.value.map((name) => t(`flows.scene.role.${name}`)).join(' / ') }), ok: listed.value ? undefined : roleOk.value },
])

// ---- Classify: the message drops into the bin of its label ----
const labels = computed(() => [...((props.config.labels ?? []) as string[]), 'other'])

// ---- Add to number: an odometer ----
const counter = computed(() => Number(step.value?.outputs?.value ?? 0))
const before = computed(() => Number(stepIn(props.passes[props.beat - 1])?.outputs?.value ?? 0))
const by = computed(() => Number(props.config.by ?? 1))

// ---- Wait for reply ----
const waitSeconds = computed(() => Number(props.config.seconds ?? 30))
const answer = computed(() => text(step.value?.outputs?.text))
</script>

<template>
  <div class="scene" :class="[`stage-${stage}`]">
    <!-- If: a junction; the lamp shows the condition, the message takes its track. -->
    <svg v-if="type === 'logic.if'" class="track" viewBox="0 0 300 104" aria-hidden="true">
      <path d="M 16 52 L 120 52" class="rail" />
      <path d="M 120 52 C 160 52, 170 20, 220 20 L 290 20" class="rail" :class="{ on: shown && exec === 'true' }" />
      <path d="M 120 52 C 160 52, 170 84, 220 84 L 290 84" class="rail" :class="{ on: shown && exec === 'false' }" />
      <text x="292" y="14" class="rail-label" :class="{ on: shown && exec === 'true' }" text-anchor="end">true</text>
      <text x="292" y="100" class="rail-label" :class="{ on: shown && exec === 'false' }" text-anchor="end">false</text>
      <g class="switch" :style="{ transform: `rotate(${decided ? (exec === 'true' ? -22 : 22) : 0}deg)` }">
        <line x1="120" y1="52" x2="150" y2="52" />
      </g>
      <g class="lamp" :class="{ lit: decided, yes: condition === true }">
        <rect x="88" y="62" width="64" height="18" rx="9" />
        <text x="120" y="75" text-anchor="middle">{{ decided ? String(condition) : '?' }}</text>
      </g>
      <foreignObject x="0" y="0" width="300" height="104">
        <div class="rider" :style="{ offsetPath: `path('${ifPath}')`, offsetDistance: ifDistance }">{{ short(pass.input.text, 6) }}</div>
      </foreignObject>
    </svg>

    <!-- Compare: A op B, then the answer. -->
    <div v-else-if="type === 'logic.compare'" class="equation">
      <div class="operand">
        <span class="operand-name">A</span>
        <span class="operand-value"><span v-for="(part, index) in aParts" :key="index" :class="{ hit: part.hit && decided }">{{ part.text }}</span></span>
      </div>
      <span class="operator" :class="{ pulse: stage === 'decide' }">{{ op }}</span>
      <div class="operand">
        <span class="operand-name">B</span>
        <span class="operand-value">{{ b }}</span>
      </div>
      <Transition name="stamp">
        <span v-if="shown" class="verdict" :class="exec === 'true' ? 'yes' : 'no'">{{ exec === 'true' ? '✓ true' : '✗ false' }}</span>
      </Transition>
    </div>

    <!-- Random: a wheel with the yes slice; it spins for every message. -->
    <div v-else-if="type === 'logic.random'" class="wheel-scene">
      <div class="wheel-box">
        <span class="pointer" />
        <svg viewBox="0 0 100 100" class="wheel" :style="{ transform: `rotate(${wheelTurn}deg)` }" aria-hidden="true">
          <circle cx="50" cy="50" :r="R" class="slice-no" />
          <circle cx="50" cy="50" :r="R" class="slice-yes" :stroke-dasharray="`${(CIRC * percent) / 100} ${CIRC}`" transform="rotate(-90 50 50)" />
          <circle cx="50" cy="50" r="6" class="hub" />
        </svg>
      </div>
      <div class="wheel-legend">
        <span class="legend yes">yes · {{ percent }}%</span>
        <span class="legend no">no · {{ 100 - percent }}%</span>
        <div class="draws">
          <span v-for="(item, index) in sofar" :key="index" class="draw" :class="item?.exec">{{ item?.exec }}</span>
        </div>
      </div>
    </div>

    <!-- Cooldown: the first message passes and starts the ring; the next one bounces. -->
    <div v-else-if="type === 'logic.cooldown'" class="gate-scene">
      <div :key="beat" class="incoming" :class="{ bounce: shown && exec === 'cooling', through: shown && exec === 'ready' }">{{ short(pass.input.text, 8) }}</div>
      <div class="gate">
        <svg viewBox="0 0 64 64" class="ring" aria-hidden="true">
          <circle cx="32" cy="32" r="26" class="ring-track" />
          <circle cx="32" cy="32" r="26" class="ring-fill" :class="{ running: coolingStarted }" transform="rotate(-90 32 32)" />
        </svg>
        <span class="ring-text">{{ coolingStarted ? `${seconds}s` : t('flows.scene.ready') }}</span>
      </div>
      <Transition name="stamp">
        <span v-if="shown" class="verdict" :class="exec === 'ready' ? 'yes' : 'no'">{{ exec }}</span>
      </Transition>
    </div>

    <!-- Rate limit and Daily quota: each message takes a slot; when they are full it bounces. -->
    <div v-else-if="type === 'logic.rateLimit' || type === 'logic.dailyQuota'" class="slots-scene">
      <div class="window-label">
        <template v-if="type === 'logic.rateLimit'">{{ t('flows.scene.window', { n: config.seconds }) }}</template>
        <template v-else><span class="day">{{ t('flows.scene.today') }}</span>{{ t('flows.scene.resetsAtMidnight') }}</template>
      </div>
      <div class="slots" :class="{ quota: type === 'logic.dailyQuota', full: blocked }">
        <span v-for="index in limit" :key="index" class="slot" :class="{ filled: index <= used }" />
      </div>
      <div :key="beat" class="incoming small" :class="{ bounce: blocked && shown, drop: !blocked && stage === 'decide' }">{{ short(pass.input.text, 8) }}</div>
      <Transition name="stamp">
        <span v-if="shown" class="verdict" :class="exec === 'ok' ? 'yes' : 'no'">
          {{ exec }}<template v-if="exec === 'limited' && step?.outputs?.retryAfter"> · {{ t('flows.scene.retryIn', { n: step.outputs.retryAfter }) }}</template>
        </span>
      </Transition>
      <span class="count">{{ used }}/{{ limit }}</span>
    </div>

    <!-- Wait: the run pauses between two replies. -->
    <div v-else-if="type === 'logic.delay'" class="pause-scene">
      <span class="bubble-mini bot">{{ short(pass.replies[0], 10) }}</span>
      <div class="clock" :class="{ ticking: stage === 'decide' }">
        <svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="16" class="ring-track" /><circle cx="20" cy="20" r="16" class="clock-fill" transform="rotate(-90 20 20)" /><line x1="20" y1="20" x2="20" y2="8" class="hand" /></svg>
        <span>{{ t('flows.scene.waitSeconds', { n: config.seconds }) }}</span>
      </div>
      <span class="bubble-mini bot" :class="{ hidden: !shown }">{{ short(pass.replies[1], 10) }}</span>
    </div>

    <!-- Wait for reply: the bot asks, the run waits for that person, the answer becomes an output. -->
    <div v-else-if="type === 'logic.waitReply'" class="reply-scene">
      <span class="bubble-mini bot">{{ short(pass.replies[0], 10) }}</span>
      <div class="waiting" :class="{ on: stage === 'decide' }">
        <span class="hourglass">⌛</span>
        <span>{{ t('flows.scene.waitUpTo', { n: waitSeconds }) }}</span>
        <span class="typing"><i /><i /><i /></span>
      </div>
      <span class="bubble-mini user" :class="{ hidden: !shown }">{{ answer }}</span>
      <Transition name="stamp">
        <span v-if="shown" class="captured">{{ t('flows.scene.captured') }}<b>{{ answer }}</b></span>
      </Transition>
    </div>

    <!-- Permission check: the sender's card against the block list and the allowed roles. -->
    <div v-else-if="type === 'logic.permission'" class="id-scene">
      <div class="id-card">
        <span class="avatar">{{ pass.input.userName.slice(0, 1) }}</span>
        <div class="id-lines">
          <span class="id-name">{{ pass.input.userId }}</span>
          <span class="id-role">{{ t(`flows.scene.role.${role}`) }}</span>
        </div>
      </div>
      <ul class="checks">
        <li v-for="(check, index) in checks" :key="check.key" :class="{ shown: decided, ok: check.ok === true, bad: check.ok === false, skip: check.ok === undefined }" :style="{ transitionDelay: `${index * 250}ms` }">
          <span class="mark">{{ check.ok === undefined ? '–' : check.ok ? '✓' : '✗' }}</span>{{ check.label }}
        </li>
      </ul>
      <Transition name="stamp">
        <span v-if="shown" class="stamp" :class="exec === 'allow' ? 'yes' : 'no'">{{ exec.toUpperCase() }}</span>
      </Transition>
    </div>

    <!-- Classify: the model reads the message and drops it in a labelled bin. -->
    <div v-else-if="type === 'ai.classify'" class="bins-scene">
      <div :key="beat" class="card-drop" :class="{ thinking: stage === 'decide', dropped: shown }" :style="{ '--bin': labels.indexOf(exec), '--bins': labels.length }">{{ short(pass.input.text, 10) }}</div>
      <div class="bins">
        <span v-for="label in labels" :key="label" class="bin" :class="{ hit: shown && label === exec }">{{ label }}</span>
      </div>
    </div>

    <!-- Add to number: the saved number rolls over to the new value. -->
    <div v-else-if="type === 'data.increment'" class="odometer-scene">
      <div class="var-box">
        <span class="var-name">{{ config.name }}</span>
        <span class="var-scope">{{ t(`flows.scene.scope.${config.scope}`) }}</span>
      </div>
      <div class="odometer">
        <Transition name="roll" mode="out-in">
          <span :key="decided ? counter : before" class="digit">{{ decided ? counter : before }}</span>
        </Transition>
      </div>
      <Transition name="stamp">
        <span v-if="stage === 'decide'" class="plus">+{{ by }}</span>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.scene {
  position: relative;
  height: 112px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 6px 10px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.06);
  overflow: hidden;
  font-size: 12px;
  --yes: var(--ok, #18a058);
  --no: var(--bad, #d03050);
  --run: var(--primary, #2080f0);
}

.verdict {
  position: absolute;
  right: 10px;
  bottom: 8px;
  padding: 1px 8px;
  border-radius: 6px;
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.03em;
}

.verdict.yes { color: var(--yes); background: color-mix(in srgb, var(--yes) 14%, transparent); }
.verdict.no { color: var(--no); background: color-mix(in srgb, var(--no) 12%, transparent); }

.stamp-enter-active { transition: opacity 0.2s, transform 0.35s cubic-bezier(0.3, 1.6, 0.5, 1); }
.stamp-enter-from { opacity: 0; transform: scale(1.6); }
.stamp-leave-active { transition: opacity 0.15s; }
.stamp-leave-to { opacity: 0; }

.hidden { visibility: hidden; }

.gate-scene, .slots-scene, .id-scene, .bins-scene, .odometer-scene, .pause-scene, .reply-scene {
  display: flex;
  align-items: center;
  justify-content: center;
}

.gate-scene { gap: 22px; }

/* ---- If ---- */
.track { width: 100%; height: 100%; overflow: visible; }
.rail { fill: none; stroke: rgba(127, 127, 127, 0.4); stroke-width: 3; stroke-linecap: round; transition: stroke 0.3s; }
.rail.on { stroke: var(--run); }
.rail-label { font-size: 10px; font-weight: 700; fill: currentColor; opacity: 0.45; transition: opacity 0.3s, fill 0.3s; }
.rail-label.on { opacity: 1; fill: var(--run); }
.switch { transform-origin: 120px 52px; transition: transform 0.45s cubic-bezier(0.3, 1.4, 0.5, 1); }
.switch line { stroke: currentColor; stroke-width: 3; stroke-linecap: round; opacity: 0.7; }
.lamp rect { fill: rgba(127, 127, 127, 0.15); transition: fill 0.3s; }
.lamp text { font-size: 10px; font-weight: 700; fill: currentColor; }
.lamp.lit rect { fill: color-mix(in srgb, var(--no) 18%, transparent); }
.lamp.lit.yes rect { fill: color-mix(in srgb, var(--yes) 20%, transparent); }
.rider {
  position: absolute;
  top: 0;
  left: 0;
  offset-rotate: 0deg;
  offset-anchor: center;
  padding: 1px 7px;
  border-radius: 9px;
  font-size: 10.5px;
  white-space: nowrap;
  color: #fff;
  background: var(--run);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
  transition: offset-distance 0.9s cubic-bezier(0.5, 0, 0.3, 1);
}

/* ---- Compare ---- */
.equation { display: flex; align-items: center; gap: 10px; }
.operand { display: grid; gap: 2px; justify-items: center; }
.operand-name { font-size: 10px; font-weight: 700; opacity: 0.5; }
.operand-value { padding: 4px 9px; border-radius: 7px; background: var(--flow-node-bg, #fff); border: 1px solid rgba(127, 127, 127, 0.3); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.operand-value .hit { border-radius: 3px; background: color-mix(in srgb, var(--yes) 28%, transparent); transition: background 0.3s; }
.operator { font-size: 16px; font-weight: 700; min-width: 22px; text-align: center; }
.operator.pulse { animation: pulse 0.5s ease-in-out 2 alternate; color: var(--run); }
@keyframes pulse { to { transform: scale(1.35); } }

/* ---- Random ---- */
.wheel-scene { display: flex; align-items: center; gap: 18px; }
.wheel-box { position: relative; width: 92px; height: 92px; }
.wheel { width: 100%; height: 100%; transition: transform 1.1s cubic-bezier(0.15, 0.7, 0.2, 1); }
.slice-no { fill: none; stroke: rgba(127, 127, 127, 0.3); stroke-width: 24; }
.slice-yes { fill: none; stroke: color-mix(in srgb, var(--yes) 70%, transparent); stroke-width: 24; }
.hub { fill: var(--flow-node-bg, #fff); stroke: rgba(127, 127, 127, 0.4); }
.pointer { position: absolute; top: -4px; left: 50%; z-index: 1; width: 0; height: 0; margin-left: -6px; border: 6px solid transparent; border-top: 10px solid currentColor; }
.wheel-legend { display: grid; gap: 4px; }
.legend { font-size: 11px; font-weight: 600; }
.legend.yes { color: var(--yes); }
.legend.no { opacity: 0.6; }
.draws { display: flex; gap: 3px; margin-top: 4px; min-height: 18px; }
.draw { padding: 0 5px; border-radius: 4px; font-size: 10px; font-weight: 700; animation: pop-in 0.3s cubic-bezier(0.3, 1.6, 0.5, 1); }
.draw.yes { color: var(--yes); background: color-mix(in srgb, var(--yes) 14%, transparent); }
.draw.no { color: var(--no); background: color-mix(in srgb, var(--no) 12%, transparent); }
@keyframes pop-in { from { transform: scale(0); } }

/* ---- Cooldown, Rate limit, Daily quota ---- */
.incoming { padding: 3px 9px; border-radius: 10px; font-size: 11px; white-space: nowrap; color: #fff; background: var(--run); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15); transition: transform 0.6s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.6s; }
.stage-in .incoming { animation: arrive 0.5s ease-out; }
@keyframes arrive { from { transform: translateX(-40px); opacity: 0; } }
.incoming.through { transform: translateX(150px); opacity: 0; }
.incoming.bounce { animation: bounce 0.6s ease-out forwards; background: var(--no); }
@keyframes bounce {
  30% { transform: translateX(46px); }
  100% { transform: translateX(-10px); }
}
.gate { position: relative; width: 64px; height: 64px; }
.ring { width: 100%; height: 100%; }
.ring-track { fill: none; stroke: rgba(127, 127, 127, 0.2); stroke-width: 5; }
.ring-fill { fill: none; stroke: var(--warn, #f0a020); stroke-width: 5; stroke-linecap: round; stroke-dasharray: 163.4; stroke-dashoffset: 163.4; }
.ring-fill.running { animation: drain 6s linear forwards; }
@keyframes drain { from { stroke-dashoffset: 0; } to { stroke-dashoffset: 120; } }
.ring-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; }

.slots-scene { flex-direction: column; gap: 8px; }
.window-label { font-size: 10.5px; opacity: 0.65; display: flex; gap: 6px; align-items: center; }
.day { padding: 0 5px; border-radius: 4px; font-weight: 700; background: rgba(127, 127, 127, 0.18); }
.slots { display: flex; gap: 6px; padding: 5px; border-radius: 8px; border: 1.5px dashed rgba(127, 127, 127, 0.35); transition: border-color 0.3s; }
.slots.full { border-color: var(--no); animation: shake 0.4s; }
.slots.quota { gap: 2px; }
.slot { width: 26px; height: 14px; border-radius: 4px; background: rgba(127, 127, 127, 0.18); transition: background 0.35s, transform 0.35s cubic-bezier(0.3, 1.6, 0.5, 1); }
.slots.quota .slot { width: 34px; border-radius: 2px; }
.slots.quota .slot:first-child { border-radius: 5px 2px 2px 5px; }
.slots.quota .slot:last-child { border-radius: 2px 5px 5px 2px; }
.slot.filled { background: var(--run); transform: scaleY(1.15); }
.slots.full .slot.filled { background: var(--no); }
.incoming.small { position: absolute; left: 12px; top: 12px; }
.incoming.drop { transform: translate(60px, 30px) scale(0.6); opacity: 0; }
.count { position: absolute; left: 12px; bottom: 8px; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; opacity: 0.7; }
@keyframes shake {
  25% { transform: translateX(-4px); }
  75% { transform: translateX(4px); }
}

/* ---- Wait, Wait for reply ---- */
.pause-scene, .reply-scene { flex-direction: column; gap: 6px; align-items: stretch; width: 100%; max-width: 300px; }
.bubble-mini { align-self: flex-end; max-width: 70%; padding: 2px 9px; border-radius: 10px 10px 3px 10px; font-size: 11px; background: color-mix(in srgb, var(--run) 16%, transparent); }
.bubble-mini.user { align-self: flex-start; border-radius: 10px 10px 10px 3px; background: rgba(127, 127, 127, 0.16); animation: arrive 0.4s ease-out; }
.clock { align-self: center; display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: 0.8; }
.clock svg { width: 26px; height: 26px; }
.clock-fill { fill: none; stroke: var(--run); stroke-width: 4; stroke-dasharray: 100.5; stroke-dashoffset: 100.5; }
.hand { stroke: currentColor; stroke-width: 2; stroke-linecap: round; transform-origin: 20px 20px; }
.clock.ticking .clock-fill { animation: fill-up 1.1s linear forwards; }
.clock.ticking .hand { animation: spin 1.1s linear forwards; }
@keyframes fill-up { to { stroke-dashoffset: 0; } }
@keyframes spin { to { transform: rotate(360deg); } }
.waiting { align-self: center; display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: 0.45; transition: opacity 0.3s; }
.waiting.on { opacity: 1; }
.waiting.on .hourglass { animation: flip 1s ease-in-out infinite; }
@keyframes flip { 50% { transform: rotate(180deg); } }
.typing { display: inline-flex; gap: 2px; }
.typing i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: 0.4; }
.waiting.on .typing i { animation: dot 0.9s infinite; }
.waiting.on .typing i:nth-child(2) { animation-delay: 0.15s; }
.waiting.on .typing i:nth-child(3) { animation-delay: 0.3s; }
@keyframes dot { 50% { opacity: 1; transform: translateY(-2px); } }
.captured { position: absolute; right: 10px; bottom: 8px; font-size: 10.5px; padding: 1px 7px; border-radius: 5px; color: var(--run); background: color-mix(in srgb, var(--run) 12%, transparent); }
.captured b { margin-left: 4px; }

/* ---- Permission ---- */
.id-scene { gap: 16px; }
.id-card { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 9px; background: var(--flow-node-bg, #fff); border: 1px solid rgba(127, 127, 127, 0.3); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08); }
.stage-in .id-card { animation: arrive 0.5s ease-out; }
.avatar { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; color: #fff; background: var(--run); }
.id-lines { display: grid; line-height: 1.3; }
.id-name { font-weight: 600; font-variant-numeric: tabular-nums; }
.id-role { font-size: 10.5px; opacity: 0.65; }
.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.checks li { display: flex; align-items: center; gap: 5px; font-size: 11px; opacity: 0.35; transition: opacity 0.3s; }
.checks li.shown { opacity: 1; }
.checks li.shown.skip { opacity: 0.4; }
.mark { width: 15px; height: 15px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; background: rgba(127, 127, 127, 0.2); }
.checks li.shown.ok .mark { color: #fff; background: var(--yes); }
.checks li.shown.bad .mark { color: #fff; background: var(--no); }
.stamp { position: absolute; right: 14px; bottom: 10px; padding: 2px 10px; border: 2.5px solid; border-radius: 6px; font-weight: 800; font-size: 14px; letter-spacing: 0.08em; transform: rotate(-10deg); }
.stamp.yes { color: var(--yes); }
.stamp.no { color: var(--no); }

/* ---- Classify ---- */
.bins-scene { flex-direction: column; gap: 18px; }
.card-drop { padding: 3px 10px; border-radius: 8px; font-size: 11px; background: var(--flow-node-bg, #fff); border: 1px solid rgba(127, 127, 127, 0.35); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1); transition: transform 0.6s cubic-bezier(0.5, 0, 0.3, 1.2), opacity 0.6s; }
.card-drop.thinking { animation: think 0.6s ease-in-out infinite alternate; }
@keyframes think { to { box-shadow: 0 0 0 4px color-mix(in srgb, var(--run) 25%, transparent); } }
.card-drop.dropped { transform: translate(calc((var(--bin) - (var(--bins) - 1) / 2) * 74px), 34px) scale(0.7); opacity: 0; }
.bins { display: flex; gap: 8px; }
.bin { width: 66px; padding: 6px 0 3px; text-align: center; border-radius: 0 0 9px 9px; border: 1.5px solid rgba(127, 127, 127, 0.35); border-top: none; font-size: 11px; font-weight: 600; transition: border-color 0.3s, background 0.3s, color 0.3s; }
.bin.hit { color: var(--run); border-color: var(--run); background: color-mix(in srgb, var(--run) 10%, transparent); }

/* ---- Add to number ---- */
.odometer-scene { gap: 12px; }
.var-box { display: grid; gap: 2px; padding: 6px 10px; border-radius: 8px; border: 1px dashed rgba(127, 127, 127, 0.45); }
.var-name { font-family: ui-monospace, monospace; font-weight: 700; }
.var-scope { font-size: 10px; opacity: 0.6; }
.odometer { width: 54px; height: 46px; border-radius: 8px; display: flex; align-items: center; justify-content: center; overflow: hidden; color: #fff; background: #26262c; box-shadow: inset 0 -6px 10px rgba(0, 0, 0, 0.35); }
.digit { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.roll-enter-active, .roll-leave-active { transition: transform 0.35s ease-in-out, opacity 0.35s; }
.roll-enter-from { transform: translateY(100%); opacity: 0; }
.roll-leave-to { transform: translateY(-100%); opacity: 0; }
.plus { font-weight: 700; color: var(--yes); font-size: 14px; }

@media (prefers-reduced-motion: reduce) {
  .scene *, .scene *::before { animation: none !important; transition: none !important; }
}
</style>
