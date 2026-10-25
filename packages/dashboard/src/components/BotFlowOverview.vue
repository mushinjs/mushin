<script setup lang="ts">
import { PlayOutline } from '@vicons/ionicons5'
import { NButton, NCard, NCheckbox, NEmpty, NIcon, NInput, NSelect, NTag, useMessage } from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call, on } from '../api'
import type { Bot, RunTrace, TriggerSlot } from '../types'

const props = defineProps<{ bot: Bot }>()
const { t } = useI18n()
const router = useRouter()
const message = useMessage()

type Role = 'member' | 'admin' | 'owner' | 'botAdmin' | 'private'
interface RouteTrigger extends TriggerSlot {
  state: 'no-match' | 'blocked' | 'ran'
  keeps?: boolean
  trace?: RunTrace
  /** Node labels of the flow, for the path. */
  labels?: Record<string, string>
}
interface RouteResult {
  text: string
  role: Role
  running: boolean
  triggers: RouteTrigger[]
  after: { kind: 'builtin' | 'plugin'; name: string; state: 'answers' | 'receives' | 'not-reached' | 'ignores'; reply?: string }[]
  replies: { from: string; text: string }[]
}

const slots = ref<TriggerSlot[]>([])
const plugins = ref<string[]>([])
const text = ref('/help')
const role = ref<Role>('member')
const useLlm = ref(false)
const running = ref(false)
const result = ref<RouteResult>()

async function refresh() {
  try {
    const order = await call<{ triggers: TriggerSlot[]; plugins: string[] }>('flows.triggers', { bot: props.bot.id })
    slots.value = order.triggers
    plugins.value = order.plugins
  } catch (error) {
    message.error((error as Error).message)
  }
}

onMounted(refresh)
watch(() => props.bot.id, () => {
  result.value = undefined
  refresh()
})
const off = on('flows/changed', refresh)
onBeforeUnmount(off)

async function trace() {
  if (!text.value.trim()) return
  running.value = true
  try {
    result.value = await call<RouteResult>('flows.route', { bot: props.bot.id, text: text.value, role: role.value, useLlm: useLlm.value })
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    running.value = false
  }
}

const roleOptions = computed(() => (['member', 'admin', 'owner', 'botAdmin', 'private'] as Role[]).map((value) => ({ label: t(`botOverview.role.${value}`), value })))
const messageSlots = computed(() => (result.value?.triggers ?? slots.value.filter((slot) => slot.source === 'message')) as RouteTrigger[])
const otherSlots = computed(() => slots.value.filter((slot) => slot.source !== 'message'))
const pluginName = (name: string) => name.replace(/^@mushin\/bot-plugin-/, '')
const afterSteps = computed(() => result.value?.after ?? [
  ...(props.bot.commands?.help !== false ? [{ kind: 'builtin' as const, name: '/help', state: undefined }] : []),
  ...plugins.value.map((name) => ({ kind: 'plugin' as const, name: pluginName(name), state: undefined })),
])

function stateLabel(slot: RouteTrigger) {
  if (!result.value) return ''
  if (slot.state === 'ran') return slot.keeps ? t('botOverview.ranKeeps') : t('botOverview.ranPasses')
  if (slot.state === 'blocked') return t('botOverview.notReached')
  return t('botOverview.noMatch')
}

/** The nodes a run went through, by name, e.g. "/checkin → 冷却 → 回复". */
function path(slot: RouteTrigger) {
  return (slot.trace?.steps ?? []).map((step) => `${slot.labels?.[step.nodeId] ?? step.nodeId}${step.error ? ' ✗' : step.skipped ? ' ⤳' : ''}`).join(' → ')
}

function open(slot: { flowId: string; nodeId: string }) {
  router.push({ path: `/flows/${slot.flowId}`, query: { node: slot.nodeId } })
}
</script>

<template>
  <div class="overview">
    <NCard :title="t('botOverview.traceTitle')" data-agent-target="bot.route">
      <div class="trace-form">
        <NInput v-model:value="text" :placeholder="t('botOverview.textPlaceholder')" class="text" @keydown.enter="trace" />
        <NSelect v-model:value="role" :options="roleOptions" class="role" />
        <NCheckbox v-model:checked="useLlm">{{ t('botOverview.useLlm') }}</NCheckbox>
        <NButton type="primary" :loading="running" :disabled="!text.trim()" @click="trace">
          <template #icon><NIcon><PlayOutline /></NIcon></template>
          {{ t('botOverview.trace') }}
        </NButton>
      </div>
      <p class="muted small">{{ t('botOverview.traceHint') }}</p>
      <div v-if="result" class="outcome">
        <template v-if="result.replies.length || result.after.some((step) => step.reply)">
          <div v-for="(reply, index) in result.replies" :key="index" class="reply"><span class="muted small">{{ reply.from }}</span>{{ reply.text }}</div>
          <div v-for="step in result.after.filter((item) => item.reply)" :key="step.name" class="reply"><span class="muted small">{{ step.name }}</span><pre>{{ step.reply }}</pre></div>
        </template>
        <p v-else-if="result.after.some((step) => step.state === 'receives')" class="muted">
          {{ t('botOverview.handedTo', { plugins: result.after.filter((step) => step.state === 'receives').map((step) => step.name).join('、') }) }}
        </p>
        <p v-else class="muted">{{ t('botOverview.noReply') }}</p>
        <p v-if="!result.running" class="warn small">{{ t('botOverview.notRunning') }}</p>
      </div>
    </NCard>

    <NCard :title="t('botOverview.orderTitle')">
      <ol class="lane">
        <li class="stage">
          <span class="stage-no">1</span>
          <div class="stage-body">
            <strong>{{ t('botOverview.received') }}</strong>
            <span v-if="result" class="muted small">「{{ result.text }}」 · {{ t(`botOverview.role.${result.role}`) }}</span>
          </div>
        </li>
        <li class="stage">
          <span class="stage-no">2</span>
          <div class="stage-body">
            <strong>{{ t('botOverview.flowTriggers') }}</strong>
            <span class="muted small">{{ t('botOverview.flowTriggersHint') }}</span>
            <div v-if="messageSlots.length" class="rows">
              <button
                v-for="slot in messageSlots"
                :key="`${slot.flowId}:${slot.nodeId}`"
                type="button"
                class="row hover-row"
                :class="result ? `state-${slot.state}` : { never: slot.certain }"
                @click="open(slot)"
              >
                <span class="row-main">
                  <span class="row-name">{{ slot.name }}</span>
                  <span class="muted small">{{ slot.flowName }} · {{ t('flows.priorityShort', { n: slot.priority }) }}{{ slot.passesOn ? ` · ${t('flows.passesOnShort')}` : '' }}</span>
                  <span v-if="slot.state === 'ran' && path(slot)" class="row-path small">{{ path(slot) }}</span>
                  <span v-if="slot.trace?.error" class="error small">{{ slot.trace.error }}</span>
                </span>
                <NTag v-if="result" size="small" :bordered="false" :type="slot.state === 'ran' ? 'success' : slot.state === 'blocked' ? 'warning' : 'default'">{{ stateLabel(slot) }}</NTag>
                <NTag v-else-if="slot.certain" size="small" :bordered="false" type="warning">{{ t('flows.blockedTag') }}</NTag>
              </button>
            </div>
            <NEmpty v-else size="small" :description="t('botOverview.noTriggers')" class="empty" />
          </div>
        </li>
        <li v-for="(step, index) in afterSteps" :key="`${step.kind}:${step.name}`" class="stage">
          <span class="stage-no">{{ index + 3 }}</span>
          <div class="stage-body">
            <strong>{{ step.kind === 'builtin' ? t('botOverview.builtin', { name: step.name }) : t('botOverview.plugin', { name: step.name }) }}</strong>
            <span class="muted small">{{ step.kind === 'builtin' ? t('botOverview.builtinHint') : t('botOverview.pluginHint') }}</span>
          </div>
          <NTag v-if="step.state" size="small" :bordered="false" :type="step.state === 'answers' ? 'success' : step.state === 'receives' ? 'info' : 'default'">
            {{ t(`botOverview.after.${step.state}`) }}
          </NTag>
        </li>
      </ol>
    </NCard>

    <NCard v-if="otherSlots.length" :title="t('botOverview.otherTitle')" size="small">
      <div class="rows">
        <button v-for="slot in otherSlots" :key="`${slot.flowId}:${slot.nodeId}`" type="button" class="row hover-row" :class="{ never: slot.certain }" @click="open(slot)">
          <span class="row-main">
            <span class="row-name">{{ slot.name }}</span>
            <span class="muted small">{{ slot.flowName }} · {{ t(`flows.kind.${slot.source}`) }} · {{ t('flows.priorityShort', { n: slot.priority }) }}</span>
          </span>
          <NTag v-if="slot.certain" size="small" :bordered="false" type="warning">{{ t('flows.blockedTag') }}</NTag>
        </button>
      </div>
    </NCard>
  </div>
</template>

<style scoped>
.overview {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.trace-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.text {
  flex: 1;
  min-width: 200px;
}

.role {
  width: 150px;
}

.outcome {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.reply {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(24, 160, 88, 0.1);
}

.reply pre {
  margin: 0;
  font: inherit;
  white-space: pre-wrap;
}

.lane {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stage {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid rgba(127, 127, 127, 0.15);
}

.stage:last-child {
  border-bottom: 0;
}

.stage-no {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  background: rgba(127, 127, 127, 0.18);
}

.stage-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rows {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid rgba(127, 127, 127, 0.18);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.row.state-ran {
  border-color: #18a058;
}

.row.state-blocked,
.row.never {
  border-style: dashed;
  border-color: #f0a020;
}

.row.state-no-match {
  opacity: 0.55;
}

.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.row-name {
  font-size: 13px;
}

.row-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  opacity: 0.8;
}

.empty {
  padding: 12px 0;
}

.muted {
  opacity: 0.65;
}

.small {
  font-size: 12px;
}

.warn {
  color: #f0a020;
}

.error {
  color: #d03050;
}
</style>
