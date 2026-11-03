<script setup lang="ts">
/**
 * The LLM node's prompt as blocks in order (persona, system rules, examples, history, the
 * message), and beside it the exact messages that go to the model, built by the server for the
 * test message or the editor's sample without calling the model.
 */
import { AddOutline, ArrowDownOutline, ArrowUpOutline, EyeOutline, RefreshOutline, TrashOutline } from '@vicons/ionicons5'
import { NButton, NDropdown, NIcon, NInput, NInputNumber, NRadioButton, NRadioGroup, NSpin, NTag } from 'naive-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { call } from '../../../api'
import VarInput from '../VarInput.vue'
import { useEditor } from './editor'
import { useNodeWiring } from './useNodeWiring'

type Block =
  | { kind: 'persona' }
  | { kind: 'system'; text: string }
  | { kind: 'example'; user: string; assistant: string }
  | { kind: 'history'; rounds: number; source: 'node' | 'chat' }
  | { kind: 'message'; text: string }

interface Line {
  role: 'system' | 'user' | 'assistant'
  content: string
  from: number | 'default'
  kind: Block['kind'] | 'default'
}

const props = defineProps<{ nodeId: string; config: Record<string, any> }>()
const emit = defineEmits<{ update: [config: Record<string, any>] }>()
const { t, flowId, sample, samplePayload, test, dirty } = useEditor()
const { varGroups } = useNodeWiring()

const blocks = computed<Block[]>(() => (Array.isArray(props.config.prompt) ? props.config.prompt : []))
const setBlocks = (next: Block[]) => emit('update', { ...props.config, prompt: next })
const setBlock = (index: number, patch: Partial<Block>) => setBlocks(blocks.value.map((block, position) => (position === index ? { ...block, ...patch } as Block : block)))
const removeBlock = (index: number) => setBlocks(blocks.value.filter((_, position) => position !== index))
function moveBlock(index: number, by: number) {
  const next = [...blocks.value]
  const [item] = next.splice(index, 1)
  next.splice(index + by, 0, item)
  setBlocks(next)
}

const KINDS: Block['kind'][] = ['persona', 'system', 'example', 'history', 'message']
const fresh = (kind: Block['kind']): Block => {
  switch (kind) {
    case 'system': return { kind, text: '' }
    case 'example': return { kind, user: '', assistant: '' }
    case 'history': return { kind, rounds: 10, source: 'chat' }
    case 'message': return { kind, text: '' }
    default: return { kind: 'persona' }
  }
}
/** Persona, history and the message make sense once; system rules and examples any number of times. */
const single = new Set<Block['kind']>(['persona', 'history', 'message'])
const addOptions = computed(() => KINDS.map((kind) => ({
  key: kind,
  label: t(`promptEditor.kinds.${kind}`),
  disabled: single.has(kind) && blocks.value.some((block) => block.kind === kind),
})))
function add(kind: Block['kind']) {
  const next = [...blocks.value]
  // New blocks go before the message, which is usually last.
  const at = kind === 'message' ? next.length : next.findIndex((block) => block.kind === 'message')
  next.splice(at < 0 ? next.length : at, 0, fresh(kind))
  setBlocks(next)
}

// ---- preview ----

const lines = ref<Line[]>([])
const previewing = ref(false)
const previewError = ref('')
const reached = ref(true)
const showPreview = ref(true)

let timer: ReturnType<typeof setTimeout> | undefined
async function refresh() {
  if (!showPreview.value) return
  previewing.value = true
  try {
    const text = test.value.text.trim()
    const result = await call<{ reached: boolean; messages: Line[]; error?: string }>('flows.preview', {
      id: flowId.value,
      nodeId: props.nodeId,
      config: props.config,
      ...(samplePayload.value && test.value.useSample ? { sample: samplePayload.value } : text ? { text, userName: test.value.userName || undefined, private: test.value.private } : {}),
    })
    lines.value = result.messages
    reached.value = result.reached
    previewError.value = result.error ?? ''
  } catch (error) {
    previewError.value = (error as Error).message
    lines.value = []
  } finally {
    previewing.value = false
  }
}
watch(() => [JSON.stringify(props.config), props.nodeId, samplePayload.value?.id, test.value.text, test.value.useSample, showPreview.value], () => {
  clearTimeout(timer)
  timer = setTimeout(refresh, 400)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(timer))

/** A rough token count: about one per CJK character and one per four other characters. */
function tokens(text: string) {
  const cjk = (text.match(/[　-鿿＀-￯]/g) ?? []).length
  return Math.ceil(cjk + (text.length - cjk) / 4)
}
const total = computed(() => lines.value.reduce((sum, line) => sum + tokens(line.content), 0))
const blockOf = (line: Line) => (typeof line.from === 'number' ? line.from : undefined)
const highlighted = ref<number>()
</script>

<template>
  <div class="prompt-editor">
    <div class="field-label">
      {{ t('promptEditor.title') }}
      <NDropdown trigger="click" :options="addOptions" @select="add">
        <NButton size="tiny" quaternary>
          <template #icon><NIcon><AddOutline /></NIcon></template>
          {{ t('promptEditor.add') }}
        </NButton>
      </NDropdown>
    </div>
    <p class="muted small hint">{{ t('promptEditor.hint') }}</p>

    <div
      v-for="(block, index) in blocks"
      :key="index"
      class="block"
      :class="[`kind-${block.kind}`, { lit: highlighted === index }]"
      @mouseenter="highlighted = index"
      @mouseleave="highlighted = undefined"
    >
      <div class="block-head">
        <span class="kind">{{ t(`promptEditor.kinds.${block.kind}`) }}</span>
        <span class="muted small desc">{{ t(`promptEditor.about.${block.kind}`) }}</span>
        <span class="tools">
          <NButton quaternary circle size="tiny" :disabled="index === 0" :aria-label="t('commandEditor.moveUp')" @click="moveBlock(index, -1)"><template #icon><NIcon><ArrowUpOutline /></NIcon></template></NButton>
          <NButton quaternary circle size="tiny" :disabled="index === blocks.length - 1" :aria-label="t('commandEditor.moveDown')" @click="moveBlock(index, 1)"><template #icon><NIcon><ArrowDownOutline /></NIcon></template></NButton>
          <NButton quaternary circle size="tiny" type="error" :aria-label="t('common.delete')" @click="removeBlock(index)"><template #icon><NIcon><TrashOutline /></NIcon></template></NButton>
        </span>
      </div>
      <VarInput
        v-if="block.kind === 'system'"
        :model-value="block.text"
        :groups="varGroups"
        multiline
        :placeholder="t('promptEditor.systemPlaceholder')"
        @update:model-value="(value: string) => setBlock(index, { text: value })"
      />
      <template v-else-if="block.kind === 'example'">
        <NInput size="small" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" :value="block.user" :placeholder="t('promptEditor.exampleUser')" @update:value="(value: string) => setBlock(index, { user: value })" />
        <NInput size="small" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" :value="block.assistant" :placeholder="t('promptEditor.exampleAssistant')" class="second" @update:value="(value: string) => setBlock(index, { assistant: value })" />
      </template>
      <div v-else-if="block.kind === 'history'" class="history">
        <NInputNumber size="small" :value="block.rounds" :min="1" :max="50" class="rounds" @update:value="(value: number | null) => setBlock(index, { rounds: value ?? 1 })">
          <template #suffix>{{ t('promptEditor.rounds') }}</template>
        </NInputNumber>
        <NRadioGroup size="small" :value="block.source" @update:value="(value: 'node' | 'chat') => setBlock(index, { source: value })">
          <NRadioButton value="chat">{{ t('promptEditor.fromChat') }}</NRadioButton>
          <NRadioButton value="node">{{ t('promptEditor.fromNode') }}</NRadioButton>
        </NRadioGroup>
      </div>
      <VarInput
        v-else-if="block.kind === 'message'"
        :model-value="block.text"
        :groups="varGroups"
        :placeholder="t('promptEditor.messagePlaceholder')"
        @update:model-value="(value: string) => setBlock(index, { text: value })"
      />
    </div>
    <p v-if="!blocks.some((block) => block.kind === 'message')" class="small warn">{{ t('promptEditor.noMessage') }}</p>

    <div class="preview-head">
      <NButton text size="small" @click="showPreview = !showPreview">
        <template #icon><NIcon><EyeOutline /></NIcon></template>
        {{ t('promptEditor.preview') }}
      </NButton>
      <NTag v-if="showPreview && lines.length" size="tiny" :bordered="false" round>{{ t('promptEditor.tokens', { n: total }) }}</NTag>
      <span class="muted small source">{{ sample && test.useSample ? t('promptEditor.fromSample') : test.text.trim() ? t('promptEditor.fromTest') : t('promptEditor.fromDefault') }}</span>
      <NButton v-if="showPreview" quaternary circle size="tiny" :aria-label="t('common.refresh')" @click="refresh"><template #icon><NIcon><RefreshOutline /></NIcon></template></NButton>
    </div>
    <NSpin v-if="showPreview" :show="previewing" size="small">
      <p v-if="dirty" class="muted small note">{{ t('promptEditor.savedOthers') }}</p>
      <p v-if="previewError" class="small warn">{{ previewError }}</p>
      <p v-else-if="!reached" class="small warn">{{ t('promptEditor.notReached') }}</p>
      <ol class="lines" :aria-label="t('promptEditor.preview')">
        <li
          v-for="(line, index) in lines"
          :key="index"
          :class="[`role-${line.role}`, { lit: blockOf(line) !== undefined && blockOf(line) === highlighted }]"
          @mouseenter="highlighted = blockOf(line)"
          @mouseleave="highlighted = undefined"
        >
          <div class="line-head">
            <span class="role">{{ t(`promptEditor.roles.${line.role}`) }}</span>
            <span class="muted small">{{ line.kind === 'default' ? t('promptEditor.defaultSystem') : t(`promptEditor.kinds.${line.kind}`) }}</span>
            <span class="muted small count">~{{ tokens(line.content) }}</span>
          </div>
          <pre class="content">{{ line.content }}</pre>
        </li>
      </ol>
    </NSpin>
  </div>
</template>

<style scoped>
.prompt-editor {
  margin-bottom: 14px;
}

.field-label {
  font-size: 13px;
  margin: 0 0 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hint {
  margin: 0 0 8px;
  line-height: 1.5;
}

.block {
  --tone: 127, 127, 127;
  border: 1px solid rgba(var(--tone), 0.28);
  border-left: 3px solid rgba(var(--tone), 0.8);
  border-radius: 8px;
  padding: 6px 8px 8px;
  margin-bottom: 6px;
  transition: background-color 0.15s;
}

.block.lit {
  background: rgba(var(--tone), 0.08);
}

.kind-persona { --tone: 166, 107, 214; }
.kind-system { --tone: 64, 128, 255; }
.kind-example { --tone: 32, 160, 140; }
.kind-history { --tone: 220, 150, 40; }
.kind-message { --tone: 24, 160, 88; }

.block-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.kind {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.desc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tools {
  display: inline-flex;
}

.second {
  margin-top: 4px;
}

.history {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.rounds {
  width: 110px;
}

.preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 6px;
}

.source {
  flex: 1;
  text-align: right;
}

.note {
  margin: 0 0 6px;
}

.warn {
  color: var(--warning, #f0a020);
  margin: 4px 0;
}

.lines {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.lines li {
  border-radius: 8px;
  padding: 6px 8px;
  background: rgba(127, 127, 127, 0.07);
  transition: box-shadow 0.15s;
}

.lines li.role-system {
  background: rgba(64, 128, 255, 0.08);
}

.lines li.role-assistant {
  background: rgba(24, 160, 88, 0.08);
}

.lines li.lit {
  box-shadow: inset 0 0 0 1px rgba(127, 127, 127, 0.45);
}

.line-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.role {
  font-size: 12px;
  font-weight: 600;
}

.count {
  margin-left: auto;
}

.content {
  margin: 4px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.55;
  max-height: 220px;
  overflow: auto;
}

@media (prefers-reduced-motion: reduce) {
  .block, .lines li {
    transition: none;
  }
}
</style>
