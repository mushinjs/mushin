<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Line } from './records'

/**
 * Lines of code or output in a box: with line numbers, or as a diff (`-` removed, `+` added). Long text
 * shows `limit` lines, the last ones with `tail` (for command output), and a button for the rest.
 */
const props = withDefaults(defineProps<{ lines: Line[]; limit?: number; tail?: boolean }>(), { limit: 30 })

const { t } = useI18n()
const all = ref(false)
const hidden = computed(() => (all.value ? 0 : Math.max(0, props.lines.length - props.limit)))
const shown = computed(() => {
  if (!hidden.value) return props.lines
  return props.tail ? props.lines.slice(-props.limit) : props.lines.slice(0, props.limit)
})
</script>

<template>
  <div class="code">
    <button v-if="hidden && tail" type="button" class="code-more top" @click="all = true">
      <span class="i-lucide-chevrons-up" />{{ t('fairyRecord.showEarlier', { n: hidden }) }}
    </button>
    <div class="code-body mono">
      <div v-for="(line, index) in shown" :key="index" class="code-line" :class="{ add: line.mark === '+', del: line.mark === '-' }">
        <span v-if="line.no !== undefined" class="code-no">{{ line.no }}</span>
        <span v-if="line.mark" class="code-mark">{{ line.mark }}</span>
        <span class="code-text">{{ line.text || ' ' }}</span>
      </div>
    </div>
    <button v-if="hidden && !tail" type="button" class="code-more" @click="all = true">
      <span class="i-lucide-chevrons-down" />{{ t('fairyRecord.showRest', { n: hidden }) }}
    </button>
  </div>
</template>

<style scoped>
.code {
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.1);
  overflow: hidden;
}

.code-body {
  max-height: 360px;
  padding: 6px 0;
  overflow: auto;
  line-height: 1.55;
}

.code-line {
  display: flex;
  min-width: max-content;
  padding: 0 10px;
}

.code-line.add {
  background: var(--ok-soft);
}

.code-line.del {
  background: var(--bad-soft);
}

.code-no {
  flex: none;
  min-width: 3ch;
  margin-right: 12px;
  color: var(--fg3);
  text-align: right;
  user-select: none;
}

.code-mark {
  flex: none;
  width: 1.5ch;
  user-select: none;
}

.add .code-mark {
  color: var(--ok);
}

.del .code-mark {
  color: var(--bad);
}

.code-text {
  white-space: pre;
}

.code-more {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 4px 10px;
  border: none;
  border-top: 1px solid var(--line);
  background: none;
  color: var(--primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.code-more.top {
  border-top: none;
  border-bottom: 1px solid var(--line);
}

.code-more:hover {
  background: rgba(127, 127, 127, 0.08);
}
</style>
