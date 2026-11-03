<script setup lang="ts">
/**
 * A trigger's place among the triggers that compete for the same message on a bot: its priority,
 * whether it stops the message there, and the order list, which can be dragged to reorder.
 */
import { ChevronDownOutline, ChevronUpOutline, InformationCircleOutline } from '@vicons/ionicons5'
import { NButton, NForm, NFormItem, NIcon, NInputNumber, NRadioButton, NRadioGroup, NSelect, NTooltip } from 'naive-ui'
import type { Intercept } from '../../../types'
import { useEditor } from './editor'
import { intercepts } from './useTriggerOrder'

const {
  t, flowId, selected, bots, botName, dirty, updateSelected,
  orderBot, competing, pluginsAfter, ordering, moveTrigger, dragFrom, dragOver, onOrderDrop, onPriorityWheel, openTrigger,
} = useEditor()
const interceptLabel = (value: Intercept) => t(`flows.intercept.${value}`)
</script>

<template>
  <div v-if="selected" class="order" data-agent-target="flows.triggerOrder">
    <div class="inputs-title">{{ t('flows.triggerOrder') }}</div>
    <NForm label-placement="top" size="small">
      <NFormItem :show-feedback="false">
        <template #label>
          <span class="label-with-hint">
            {{ t('flows.priority') }}
            <NTooltip :style="{ maxWidth: '280px' }">
              <template #trigger><NIcon :size="14" class="type-hint"><InformationCircleOutline /></NIcon></template>
              {{ t('flows.priorityHint') }} {{ t('flows.priorityWheel') }}
            </NTooltip>
          </span>
        </template>
        <div class="priority-input" :title="t('flows.priorityWheel')" @wheel.prevent="onPriorityWheel">
          <NInputNumber :value="selected.data!.priority ?? 0" :precision="0" @update:value="(value: number | null) => updateSelected({ priority: value || undefined })" />
        </div>
      </NFormItem>
      <NFormItem :label="t('flows.interceptTitle')" :feedback="t(`flows.interceptHint.${selected.data!.intercept ?? 'none'}`)" data-agent-target="flows.intercept">
        <NRadioGroup :value="selected.data!.intercept ?? 'none'" size="small" @update:value="(value: Intercept) => updateSelected({ intercept: value === 'none' ? undefined : value })">
          <NRadioButton v-for="value in intercepts" :key="value" :value="value">{{ interceptLabel(value) }}</NRadioButton>
        </NRadioGroup>
      </NFormItem>
    </NForm>
    <template v-if="bots.length">
      <div class="order-head">
        <span class="muted small">{{ t('flows.competing') }}</span>
        <NSelect v-if="bots.length > 1" v-model:value="orderBot" size="tiny" class="order-bot" :options="bots.map((id) => ({ label: botName(id), value: id }))" />
        <span v-else class="muted small">{{ botName(bots[0]) }}</span>
      </div>
      <ol v-if="competing.length" class="order-list">
        <li
          v-for="(slot, index) in competing"
          :key="`${slot.flowId}:${slot.nodeId}`"
          :class="{ current: slot.flowId === flowId && slot.nodeId === selected.id, blocked: slot.certain, dragging: dragFrom === index, over: dragOver === index && dragFrom !== index }"
          :draggable="!ordering"
          @dragstart="dragFrom = index"
          @dragover.prevent="dragOver = index"
          @dragleave="dragOver === index && (dragOver = undefined)"
          @drop.prevent="onOrderDrop(index)"
          @dragend="dragFrom = undefined; dragOver = undefined"
        >
          <span class="order-grip" :title="t('flows.dragToOrder')">⋮⋮</span>
          <button type="button" class="order-name" :title="t('flows.focusTrigger')" @click="openTrigger(slot)">
            <span><span class="order-number">{{ String(slot.number).padStart(2, '0') }}</span>{{ slot.name }}</span>
            <span class="muted small">{{ slot.flowName }} · {{ t('flows.priorityShort', { n: slot.priority }) }}{{ slot.intercept !== 'none' ? ` · ${t('flows.interceptShort', { scope: interceptLabel(slot.intercept) })}` : '' }}</span>
            <span v-if="slot.certain" class="order-tag">{{ t('flows.blockedTag') }}</span>
            <span v-else-if="slot.blockedBy" class="order-tag maybe">{{ t('flows.maybeBlocked') }}</span>
          </button>
          <NButton quaternary circle size="tiny" :disabled="ordering || index === 0" :aria-label="t('flows.moveUp')" :title="t('flows.moveUp')" @click="moveTrigger(index, -1)">
            <template #icon><NIcon><ChevronUpOutline /></NIcon></template>
          </NButton>
          <NButton quaternary circle size="tiny" :disabled="ordering || index === competing.length - 1" :aria-label="t('flows.moveDown')" :title="t('flows.moveDown')" @click="moveTrigger(index, 1)">
            <template #icon><NIcon><ChevronDownOutline /></NIcon></template>
          </NButton>
        </li>
      </ol>
      <p class="muted small">
        {{ pluginsAfter.length ? t('flows.afterFlows', { plugins: pluginsAfter.map((name) => name.replace(/^@mushin\/bot-plugin-/, '')).join('、') }) : t('flows.afterFlowsNone') }}
        <template v-if="dirty"> {{ t('flows.orderPreview') }}</template>
      </p>
    </template>
    <p v-else class="muted small">{{ t('flows.orderNoBots') }}</p>
  </div>
</template>

<style scoped src="./panel.css"></style>

<style scoped>
.order {
  margin: 4px 0 14px;
}

.order-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.order-bot {
  width: 140px;
}

.order-list {
  margin: 0 0 6px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.order-list li {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgba(127, 127, 127, 0.2);
}

.order-list li.dragging {
  opacity: 0.4;
}

.order-list li.over {
  box-shadow: 0 -2px 0 var(--primary);
}

.order-grip {
  flex: none;
  cursor: grab;
  opacity: 0.45;
  font-size: 11px;
  letter-spacing: -2px;
  user-select: none;
}

.order-number {
  margin-right: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  opacity: 0.6;
}

.priority-input {
  width: 100%;
}

.order-list li.current {
  border-color: var(--primary);
}

.order-list li.blocked {
  border-style: dashed;
  border-color: var(--warn);
}

.order-name {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.order-tag {
  font-size: 11px;
  color: var(--warn);
}

.order-tag.maybe {
  opacity: 0.75;
}
</style>
