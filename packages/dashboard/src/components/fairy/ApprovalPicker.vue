<script setup lang="ts">
import { Popover } from '@mushinjs/ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { type ApprovalMode, useConversation } from '../../stores/fairy'

/**
 * When Fairy asks before acting: before any change, as the settings say, only before what could do lasting harm,
 * or never. A switch also reaches the reply Fairy is working on.
 */
const { t } = useI18n()
const fairy = useConversation()
const show = ref(false)

const MODES: { key: ApprovalMode; icon: string }[] = [
  { key: 'ask', icon: 'i-lucide-hand' },
  { key: 'default', icon: 'i-lucide-shield' },
  { key: 'auto', icon: 'i-lucide-shield-check' },
  { key: 'full', icon: 'i-lucide-shield-alert' },
]
const current = computed(() => MODES.find((mode) => mode.key === fairy.approvals) ?? MODES[1]!)

function pick(mode: ApprovalMode) {
  fairy.setApprovals(mode)
  show.value = false
}
</script>

<template>
  <Popover v-model:show="show" placement="top" align="end" :padded="false" :width="320">
    <template #trigger>
      <button type="button" class="approval-chip" :class="current.key" :title="t('fairyApprovals.title')">
        <span :class="current.icon" />
        <span class="approval-label">{{ t(`fairyApprovals.modes.${current.key}.name`) }}</span>
        <span class="i-lucide-chevron-down approval-caret" />
      </button>
    </template>
    <div class="approvals">
      <div class="approvals-title">{{ t('fairyApprovals.title') }}</div>
      <button
        v-for="mode in MODES"
        :key="mode.key"
        type="button"
        class="approval-item"
        :class="[mode.key, { current: mode.key === current.key }]"
        @click="pick(mode.key)"
      >
        <span class="approval-icon" :class="mode.icon" />
        <span class="approval-text">
          <span class="approval-name">{{ t(`fairyApprovals.modes.${mode.key}.name`) }}</span>
          <span class="approval-desc">{{ t(`fairyApprovals.modes.${mode.key}.desc`) }}</span>
        </span>
        <span v-if="mode.key === current.key" class="i-lucide-check approval-check" />
      </button>
      <p class="approvals-hint">{{ t('fairyApprovals.hint') }}</p>
    </div>
  </Popover>
</template>

<style scoped>
.approval-chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg3);
  font-size: 12px;
  cursor: pointer;
}

.approval-chip:hover,
.approval-chip[data-state='open'] {
  background: var(--s2);
  color: var(--fg);
}

.approval-chip.auto {
  color: var(--primary);
}

.approval-chip.full {
  color: var(--warn);
}

.approval-caret {
  font-size: 12px;
}

.approvals {
  display: flex;
  flex-direction: column;
  padding: 6px;
  font-size: 13px;
}

.approvals-title {
  padding: 6px 8px 4px;
  color: var(--fg3);
  font-size: 12px;
}

.approval-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.approval-item:hover {
  background: var(--s2);
}

.approval-icon {
  flex: none;
  margin-top: 2px;
  font-size: 16px;
  color: var(--fg2);
}

.approval-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.approval-name {
  font-weight: 500;
}

.approval-desc {
  color: var(--fg3);
  font-size: 12px;
  line-height: 1.45;
}

.approval-item.full .approval-icon,
.approval-item.full .approval-name {
  color: var(--warn);
}

.approval-check {
  flex: none;
  margin-top: 2px;
  color: var(--primary);
}

.approvals-hint {
  margin: 4px 8px 4px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
  color: var(--fg3);
  font-size: 11px;
}
</style>
