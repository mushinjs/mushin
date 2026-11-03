<script setup lang="ts">
/**
 * The inspector's node tab: the selected node's name, notes on why it may not run, its settings and
 * its wiring. Keyword and command triggers can be turned into each other from here.
 */
import { BanOutline, InformationCircleOutline, TrashOutline } from '@vicons/ionicons5'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NIcon, NInput, NTabPane, NTabs, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { categoryColors, portColors, schemaDefaults } from '../../../flow'
import { clone, localize } from '../../../utils'
import SchemaForm from '../../SchemaForm.vue'
import { nodeIcon } from '../icons'
import VarInput from '../VarInput.vue'
import { useEditor } from './editor'
import CommandEditor from './CommandEditor.vue'
import MessageEditor from './MessageEditor.vue'
import PromptEditor from './PromptEditor.vue'
import NodeWiring from './NodeWiring.vue'
import TriggerOrder from './TriggerOrder.vue'
import { refExamples, useNodeWiring } from './useNodeWiring'

const {
  t, locale, message, types, selected, selectedId, selectedInfo, selectedIsTrigger, order, nodeTab, typeTitle, portLabel, issuesByNode,
  inheritedSkip, blockedNodes, blockedSlots, toggleSkip, deleteSelected, updateSelected, openTrigger, bots, sampleValue,
} = useEditor()
const { wiring, varGroups, setInput } = useNodeWiring()

const selectedNumber = computed(() => String((order.value.get(selectedId.value ?? '') ?? 0) + 1).padStart(2, '0'))
const selectedColor = computed(() => (selectedInfo.value ? categoryColors[selectedInfo.value.category] : '#8c8c8c'))
const selectedIcon = computed(() => selected.value && nodeIcon(selected.value.data!.typeId, selectedInfo.value?.category))

// ---- keyword and command triggers ----

const COMMAND = 'trigger.command'
/** Fields the command editor shows itself. */
const COMMAND_FIELDS = ['name', 'prefixes', 'aliases', 'args']
const KEYWORD = 'trigger.keyword'
const unprefixed = (text: string) => text.trim().replace(/^\/+/, '')
const keywordsOf = (config: Record<string, any>): string[] => (Array.isArray(config.keywords) ? config.keywords.map((item: unknown) => String(item).trim()) : [])

/** On a keyword node, the first keyword written like a command (`/foo`); it stays plain text unless the node is converted. */
const commandLike = computed(() => {
  if (selected.value?.data!.typeId !== KEYWORD || !types.value.has(COMMAND)) return
  return keywordsOf(selected.value.data!.config).find((item) => item.length > 1 && item.startsWith('/'))
})

/** Turns the selected keyword node into a command node named after `commandLike`, other keywords becoming aliases. Keeps the node id, so `{{<id>.rest}}` still works. */
function convertToCommand() {
  const command = types.value.get(COMMAND)
  const first = commandLike.value
  if (!command || !first || !selected.value) return
  const config = selected.value.data!.config
  updateSelected({
    typeId: COMMAND,
    config: {
      ...schemaDefaults(command.configSchema),
      name: unprefixed(first),
      aliases: [...new Set(keywordsOf(config).map(unprefixed))].filter((item) => item && item !== unprefixed(first)),
    },
  })
  message.success(t('flows.convertedToCommand', { name: `/${unprefixed(first)}` }))
}

/** Fields with an editor of their own: an LLM node's prompt blocks, a reply's message text. */
const widgetFields = computed(() => Object.entries<Record<string, any>>(selectedInfo.value?.configSchema?.properties ?? {})
  .filter(([, field]) => field['x-widget'] === 'prompt' || field['x-widget'] === 'message')
  .map(([key, field]) => ({ key, widget: field['x-widget'] as 'prompt' | 'message', label: field['x-i18n']?.[locale.value]?.title ?? field.title ?? key })))
const hiddenFields = computed(() => [
  ...(selected.value?.data!.typeId === COMMAND ? COMMAND_FIELDS : leadFields.value),
  ...widgetFields.value.map((item) => item.key),
])
const setField = (key: string, value: unknown) => updateSelected({ config: clone({ ...selected.value!.data!.config, [key]: value }) })

/** Settings fields shown above the conversion hint: the keywords of a keyword node. */
const leadFields = computed(() => (selected.value?.data!.typeId === KEYWORD ? ['keywords'] : []))
const otherFields = (schema: { properties?: Record<string, unknown> }, keep: string[]) => Object.keys(schema.properties ?? {}).filter((name) => !keep.includes(name))
</script>

<template>
  <template v-if="selected && selectedInfo">
    <div class="node-head" :style="{ '--accent': selectedColor }">
      <span class="node-icon"><NIcon :size="20"><component :is="selectedIcon" /></NIcon></span>
      <div class="node-title">
        <!-- The title is the node's name: type to rename it, clear it to use the type's name. -->
        <div class="node-name">
          <span class="node-number">{{ selectedNumber }}</span>
          <input
            class="name-edit"
            :value="selected.data!.label ?? ''"
            :placeholder="typeTitle(selected.data!.typeId)"
            :title="t('flows.renameHint')"
            :aria-label="t('flows.nodeLabel')"
            @input="updateSelected({ label: ($event.target as HTMLInputElement).value || undefined })"
            @keydown.enter="($event.target as HTMLInputElement).blur()"
          >
        </div>
        <div class="muted small type-line">
          {{ selected.data!.label ? typeTitle(selected.data!.typeId) : selected.data!.typeId }}
          <NTooltip v-if="selectedInfo.description" :style="{ maxWidth: '300px' }">
            <template #trigger><NIcon :size="13" class="type-hint"><InformationCircleOutline /></NIcon></template>
            {{ localize(selectedInfo.description, locale) }}
          </NTooltip>
        </div>
      </div>
      <NButton
        quaternary
        circle
        size="small"
        :type="selected.data!.skip ? 'warning' : 'default'"
        :title="selected.data!.skip ? t('flows.unskipNode') : `${t('flows.skipNode')}：${t('flows.skipNodeHint')}`"
        :aria-label="selected.data!.skip ? t('flows.unskipNode') : t('flows.skipNode')"
        :aria-pressed="!!selected.data!.skip"
        data-agent-target="flows.skipNode"
        @click="toggleSkip([selected.id])"
      >
        <template #icon><NIcon><BanOutline /></NIcon></template>
      </NButton>
      <NButton quaternary circle size="small" type="error" :title="t('flows.deleteNode')" :aria-label="t('flows.deleteNode')" @click="deleteSelected">
        <template #icon><NIcon><TrashOutline /></NIcon></template>
      </NButton>
    </div>

    <NAlert v-if="!selected.data!.skip && inheritedSkip.get(selected.id)" type="warning" :show-icon="false" class="skip-note">
      {{ t('flows.inheritedSkip', { name: inheritedSkip.get(selected.id) }) }}
    </NAlert>
    <NAlert v-if="blockedNodes.get(selected.id)" type="warning" :show-icon="false" class="skip-note">
      {{ blockedNodes.get(selected.id)!.reason }}
      <template v-if="blockedNodes.get(selected.id)!.trigger">
        <NButton
          v-for="slot in blockedSlots.filter((item) => item.nodeId === selected!.id && item.certain).slice(0, 1)"
          :key="slot.botId"
          size="tiny"
          secondary
          type="warning"
          class="note-action"
          @click="openTrigger(slot.blockedBy!)"
        >{{ t('flows.goToBlocker') }}</NButton>
      </template>
    </NAlert>
    <NTabs v-model:value="nodeTab" type="segment" size="small" class="node-tabs">
      <NTabPane name="settings" :tab="t('flows.nodeSettings')">
        <template v-if="wiring?.inputs.length">
          <div class="inputs-title">{{ t('flows.ioInputs') }}</div>
          <NForm label-placement="top" size="small">
            <NFormItem v-for="item in wiring.inputs" :key="item.port.name">
              <template #label>
                {{ portLabel(item.port) }}
                <span class="port-type" :style="{ color: portColors[item.port.type] }">{{ item.port.type }}</span>
              </template>
              <div class="input-cell">
                <VarInput :model-value="item.binding" :groups="varGroups" @update:model-value="(value: string) => setInput(item.port.name, value)" />
                <span v-if="sampleValue(item.binding) !== undefined" class="muted small sample-value" :title="sampleValue(item.binding)">
                  {{ t('flows.sampleValue', { value: sampleValue(item.binding) || '""' }) }}
                </span>
              </div>
            </NFormItem>
          </NForm>
          <p class="muted small vars-hint">{{ t('flows.varsHint', refExamples) }}</p>
        </template>
        <CommandEditor
          v-if="selected.data!.typeId === COMMAND"
          :config="selected.data!.config"
          :bots="bots"
          @update="(config: Record<string, any>) => updateSelected({ config: clone(config) })"
        />
        <template v-if="selectedInfo.configSchema">
          <SchemaForm
            v-if="leadFields.length"
            compact
            :model-value="selected.data!.config"
            :schema="selectedInfo.configSchema"
            :hidden="otherFields(selectedInfo.configSchema, leadFields)"
            @update:model-value="(config: Record<string, any>) => updateSelected({ config: clone(config) })"
          />
          <template v-for="item in widgetFields" :key="item.key">
            <PromptEditor
              v-if="item.widget === 'prompt'"
              :node-id="selected.id"
              :config="selected.data!.config"
              @update="(config: Record<string, any>) => updateSelected({ config: clone(config) })"
            />
            <MessageEditor
              v-else
              :label="item.label"
              :model-value="selected.data!.config[item.key] ?? ''"
              :quote="!!selected.data!.config.quote"
              @update:model-value="(value: string) => setField(item.key, value)"
            />
          </template>
          <NAlert v-if="commandLike" type="info" :show-icon="false" class="convert-hint">
            {{ t('flows.suggestCommand', { name: commandLike }) }}
            <NButton size="tiny" secondary type="primary" @click="convertToCommand">{{ t('flows.convertToCommand') }}</NButton>
          </NAlert>
          <SchemaForm
            compact
            :model-value="selected.data!.config"
            :schema="selectedInfo.configSchema"
            :hidden="hiddenFields"
            @update:model-value="(config: Record<string, any>) => updateSelected({ config: clone(config) })"
          />
        </template>
        <TriggerOrder v-if="selectedIsTrigger" />
        <NAlert v-for="(issue, index) in issuesByNode.get(selected.id) ?? []" :key="index" :type="issue.severity" :show-icon="false" class="issue">
          {{ issue.message }}
          <RouterLink v-if="issue.plugin" :to="`/plugins?highlight=${issue.plugin}`" class="issue-link">{{ t('flows.enablePlugin') }}</RouterLink>
        </NAlert>
        <!-- The type's notes on what is easy to get wrong, under everything else. -->
        <ul v-if="selectedInfo.guide?.notes?.length" class="guide-notes muted small">
          <li v-for="(note, index) in selectedInfo.guide.notes.slice(0, 3)" :key="index">{{ localize(note, locale) }}</li>
        </ul>
      </NTabPane>

      <NTabPane name="io" :tab="t('flows.nodeIO')">
        <NodeWiring />
      </NTabPane>
    </NTabs>
  </template>
  <NEmpty v-else :description="t('flows.selectNode')" class="panel-empty" />
</template>

<style scoped src="./panel.css"></style>

<style scoped>
.node-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0 12px;
}

.node-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  color: var(--accent-fg);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}

.node-title {
  flex: 1;
  min-width: 0;
}

.node-name {
  display: flex;
  align-items: baseline;
  font-size: 15px;
  font-weight: 600;
  min-width: 0;
}

.name-edit {
  flex: 1;
  min-width: 0;
  padding: 1px 4px;
  margin-left: -4px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-overflow: ellipsis;
}

.name-edit:hover {
  border-color: rgba(127, 127, 127, 0.3);
}

.name-edit:focus {
  outline: none;
  border-color: var(--primary);
}

.name-edit::placeholder {
  color: inherit;
  opacity: 1;
}

.type-line {
  display: flex;
  align-items: center;
  gap: 4px;
}

.node-number {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-weight: 400;
  opacity: 0.5;
  margin-right: 8px;
}

.node-tabs {
  margin-bottom: 4px;
}

.node-tabs :deep(.n-tab-pane) {
  padding-top: 14px;
}

.port-type {
  font-size: 11px;
  margin-left: 4px;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}

.vars-hint {
  margin: -6px 0 14px;
  line-height: 1.6;
}

.note-action {
  margin-left: 6px;
}

.skip-note {
  margin: 0 0 10px;
  font-size: 13px;
}

.convert-hint {
  margin: -6px 0 14px;
  font-size: 13px;
}

.convert-hint :deep(.n-button) {
  margin-left: 6px;
}

.input-cell {
  display: grid;
  gap: 2px;
  width: 100%;
}

.sample-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.guide-notes {
  margin: 14px 0 4px;
  padding: 10px 0 0 18px;
  border-top: 1px dashed rgba(127, 127, 127, 0.25);
  line-height: 1.6;
}

.panel-empty {
  margin-top: 40px;
}
</style>
