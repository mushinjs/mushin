<script setup lang="ts">
import { Spin } from '@mushinjs/ui'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFairyActivityStore } from '../../stores/fairyActivity'
import { cachedPreview, loadPreview, relativeTime, type SessionPreview } from './preview'
import { actionLabel } from './records'

/**
 * A look at a conversation without opening it, for a hover card: how it stands, its last messages, the last steps
 * Fairy took and an approval it waits on. `task` is a helper's conversation under its task card, which names the
 * task itself: only the helper's own words show. It loads when shown and keeps up while the conversation works.
 */
const props = defineProps<{ session: string; variant?: 'session' | 'task'; /** When the list last saw it change. */ updatedAt?: number }>()

const { t, te } = useI18n()
const activity = useFairyActivityStore()
const data = ref<SessionPreview | undefined>(cachedPreview(props.session))
const failed = ref(false)

let timer = 0
async function refresh() {
  try {
    // One at work, by what the activity bar knows, is asked for anew even when the last look found it resting.
    data.value = await loadPreview(props.session, { fresh: !!activity.of(props.session), updatedAt: props.updatedAt })
    failed.value = false
  } catch {
    failed.value = !data.value
  }
  // A conversation at work moves on while you look.
  window.clearTimeout(timer)
  if (data.value?.running) timer = window.setTimeout(refresh, 2000)
}
onMounted(refresh)
onBeforeUnmount(() => window.clearTimeout(timer))

const live = computed(() => activity.of(props.session))
const isTask = computed(() => props.variant === 'task')

const state = computed(() => {
  if (live.value?.waiting) return { tone: 'warn', icon: 'i-lucide-hand', text: t(`fairyActivity.${live.value.waiting}`) }
  if (live.value || data.value?.running) return { tone: 'busy', icon: '', text: t('fairyActivity.running') }
  // A helper's card already says how its task ended.
  if (!data.value || isTask.value) return undefined
  const recent = Date.now() - data.value.updatedAt < 60_000
  return { tone: 'idle', icon: 'i-lucide-clock-3', text: recent ? t('fairyPeek.idle') : t('fairyPeek.idleAgo', { time: relativeTime(data.value.updatedAt, t) }) }
})

const messages = computed(() => (isTask.value ? data.value?.messages.filter((message) => message.role === 'assistant').slice(-2) : data.value?.messages) ?? [])
const label = (action: string) => actionLabel(action, t, te)
const roleName = computed(() => (data.value?.role ? (te(`fairyTask.roles.${data.value.role}`) ? t(`fairyTask.roles.${data.value.role}`) : data.value.role) : undefined))
</script>

<template>
  <div class="peek">
    <slot name="head" />
    <div v-if="!isTask" class="peek-head">
      <span v-if="roleName" class="peek-role">{{ roleName }}</span>
      <strong class="peek-title">{{ data?.title || t('fairy.untitled') }}</strong>
    </div>
    <div v-if="state" class="peek-state" :class="state.tone">
      <Spin v-if="state.tone === 'busy'" :size="10" />
      <span v-else :class="state.icon" />
      {{ state.text }}
      <span v-if="data && !isTask" class="peek-count">· {{ t('fairyPeek.messages', data.total) }}</span>
    </div>

    <div v-if="!data" class="peek-loading">
      <span v-if="failed">{{ t('fairyPeek.failed') }}</span>
      <Spin v-else :size="14" />
    </div>
    <template v-else>
      <ol v-if="messages.length" class="peek-messages">
        <li v-for="(message, index) in messages" :key="`${message.at}-${index}`" :class="message.role">
          <span class="peek-who">{{ message.role === 'user' ? t('fairyPeek.you') : isTask ? roleName ?? 'Fairy' : 'Fairy' }}</span>
          <!-- One line: the text keeps its own breaks, so no space may sit before it. -->
          <span class="peek-text"><span v-for="ref in message.refs ?? []" :key="ref" class="peek-ref">{{ ref }}</span>{{ message.text }}</span>
        </li>
      </ol>
      <p v-else class="peek-empty">{{ isTask ? t('fairyPeek.noWords') : t('fairyPeek.empty') }}</p>

      <div v-if="data.steps.length" class="peek-steps">
        <div class="peek-label">{{ t('fairyPeek.steps') }}</div>
        <ul>
          <li v-for="(step, index) in data.steps" :key="index" :class="step.state">
            <Spin v-if="step.state === 'running' && !data.waiting" :size="10" />
            <span v-else-if="step.state === 'running'" class="i-lucide-hand" />
            <span v-else-if="step.state === 'ok'" class="i-lucide-check" />
            <span v-else class="i-lucide-x" />
            <span class="peek-step" :title="step.action">{{ label(step.action) }}</span>
          </li>
        </ul>
      </div>
      <div v-if="data.waiting" class="peek-waiting">
        <span class="i-lucide-hand" />{{ t('fairyPeek.waiting', { action: label(data.waiting.action) }) }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.peek {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.5;
  max-height: min(70vh, 460px);
  overflow-y: auto;
}

.peek-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.peek-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.peek-role {
  flex: none;
  padding: 0 6px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.14);
  font-size: 12px;
}

.peek-state {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: -4px;
  color: var(--fg3);
  font-size: 12px;
}

.peek-state.warn {
  color: var(--warn);
}

.peek-state.busy {
  color: var(--primary);
}

.peek-count {
  color: var(--fg3);
}

.peek-loading {
  display: flex;
  justify-content: center;
  padding: 10px 0;
  color: var(--fg3);
  font-size: 12px;
}

.peek-messages {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 8px 0 0;
  border-top: 1px solid var(--line);
  list-style: none;
}

.peek-messages li {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.peek-who {
  color: var(--fg3);
  font-size: 11px;
}

.peek-messages li.user .peek-who {
  color: var(--primary);
}

.peek-text {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--fg2);
  white-space: pre-wrap;
  word-break: break-word;
}

.peek-ref {
  display: inline-block;
  margin-right: 4px;
  padding: 0 5px;
  border-radius: 6px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 11px;
}

.peek-empty {
  margin: 0;
  color: var(--fg3);
  font-size: 12px;
}

.peek-steps {
  padding-top: 8px;
  border-top: 1px solid var(--line);
}

.peek-label {
  margin-bottom: 4px;
  color: var(--fg3);
  font-size: 11px;
}

.peek-steps ul {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}

.peek-steps li {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--fg2);
}

.peek-steps li .i-lucide-check {
  color: var(--ok);
}

.peek-steps li .i-lucide-x {
  color: var(--bad);
}

.peek-steps li .i-lucide-hand {
  color: var(--warn);
}

.peek-step {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.peek-waiting {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 12px;
}
</style>
