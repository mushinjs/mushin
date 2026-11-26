<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChatItem } from '../../stores/fairy'
import { useDataStore } from '../../stores/data'
import { actionLabel, callSummary } from './records'
import ToolDetail from './ToolDetail.vue'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/**
 * A look at folded tool calls, for a hover card. One call shows what went in and came out, as it does opened;
 * a run of calls lists each one with what it worked on and how it went, the newest last.
 */
const props = defineProps<{ items: ToolItem[] }>()

const { t, te } = useI18n()
const data = useDataStore()

/** Most calls a run lists; the earlier ones are counted. */
const SHOWN = 12

const single = computed(() => (props.items.length === 1 ? props.items[0] : undefined))
const shown = computed(() => props.items.slice(-SHOWN))
const hidden = computed(() => props.items.length - shown.value.length)

const line = (item: ToolItem) => {
  const question = item.action === 'ui.ask' ? (item.input as { question?: unknown } | undefined)?.question : undefined
  if (typeof question === 'string' && question) return { text: question, code: false }
  const summary = callSummary(item.action, item.input, data)
  if (summary.text) return summary
  // Something it could not name, such as a bot that is not there: its id still tells the calls apart.
  const id = (item.input as { id?: unknown } | undefined)?.id
  if (typeof id === 'string' && id) return { text: id, code: true }
  return { text: actionLabel(item.action, t, te), code: false }
}
const stateIcon = (item: ToolItem) => ({ ok: 'i-lucide-check', error: 'i-lucide-x', declined: 'i-lucide-ban', confirm: 'i-lucide-hand', running: 'i-lucide-loader' }[item.state])
</script>

<template>
  <div class="tool-peek">
    <template v-if="single">
      <div class="peek-head">
        <span :class="[stateIcon(single), single.state]" class="peek-icon" />
        <strong>{{ actionLabel(single.action, t, te) }}</strong>
        <span v-if="line(single).text !== actionLabel(single.action, t, te)" class="peek-sub" :class="{ mono: line(single).code }">{{ line(single).text }}</span>
      </div>
      <ToolDetail :item="single" />
    </template>
    <template v-else>
      <div class="peek-head"><strong>{{ actionLabel(items[0]!.action, t, te) }}</strong><span class="peek-count">×{{ items.length }}</span></div>
      <p v-if="hidden" class="peek-more">{{ t('fairyPeek.earlier', hidden) }}</p>
      <ul class="peek-list">
        <li v-for="item in shown" :key="item.id" :class="item.state">
          <span :class="stateIcon(item)" class="peek-icon" />
          <span class="peek-line">
            <span :class="{ mono: line(item).code }">{{ line(item).text }}</span>
            <span v-if="item.error" class="peek-error">{{ item.error.replace(/^Error:\s*/, '') }}</span>
          </span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.tool-peek {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: min(60vh, 380px);
  overflow-y: auto;
  padding: 10px 12px;
  font-size: 12px;
}

.peek-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 6px;
  font-size: 13px;
}

.peek-sub {
  flex-basis: 100%;
  color: var(--fg2);
  font-size: 12px;
  word-break: break-all;
}

.peek-count,
.peek-more {
  margin: 0;
  color: var(--fg3);
  font-size: 12px;
}

.peek-icon {
  flex: none;
  align-self: center;
  font-size: 13px;
  color: var(--fg3);
}

.peek-icon.i-lucide-check,
.peek-head .ok {
  color: var(--ok);
}

.peek-icon.i-lucide-x {
  color: var(--bad);
}

.peek-icon.i-lucide-hand {
  color: var(--warn);
}

.peek-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.peek-list li {
  display: flex;
  gap: 6px;
}

.peek-line {
  display: flex;
  flex-direction: column;
  min-width: 0;
  color: var(--fg2);
  word-break: break-all;
}

.peek-error {
  color: var(--bad);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.mono {
  font-family: var(--mono);
}
</style>
