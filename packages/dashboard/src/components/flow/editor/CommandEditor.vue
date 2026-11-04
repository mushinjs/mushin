<script setup lang="ts">
/**
 * The command node's head: its prefixes and name side by side, then its arguments as a list
 * (one row per argument), the usage line they make and a box to try a message against them.
 */
import { Button, Checkbox, Input, Select, Tag, TagsInput } from '@mushin/ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../../../api'
import { useDataStore } from '../../../stores/data'

export type ArgType = 'text' | 'number' | 'boolean' | 'user' | 'choice'
export interface CommandArg {
  name: string
  type: ArgType
  optional?: boolean
  rest?: boolean
  default?: string | number | boolean
  choices?: string[]
  description?: string
}

interface TryResult {
  matched: boolean
  reason?: 'prefix' | 'name'
  ok?: boolean
  values?: Record<string, unknown>
  error?: string
  arg?: string
  usage: string
}

const props = defineProps<{
  config: Record<string, any>
  /** Bots that run the flow; the first one's prefixes apply when the command has none. */
  bots: string[]
}>()
const emit = defineEmits<{ update: [config: Record<string, any>] }>()
const { t } = useI18n()
const data = useDataStore()

const ARG_TYPES: ArgType[] = ['text', 'number', 'boolean', 'user', 'choice']
const typeOptions = computed(() => ARG_TYPES.map((type) => ({ value: type, label: t(`commandEditor.types.${type}`) })))

const args = computed<CommandArg[]>(() => (Array.isArray(props.config.args) ? props.config.args : []))
const prefixes = computed<string[]>(() => (Array.isArray(props.config.prefixes) ? props.config.prefixes : []))
const botPrefixes = computed(() => {
  const bot = data.bots.find((item) => item.id === props.bots[0])
  const list = bot?.commands?.prefixes?.filter(Boolean)
  return list?.length ? list : ['/']
})
const shownPrefix = computed(() => prefixes.value[0] ?? botPrefixes.value[0])
const followsBot = computed(() => !prefixes.value.length)

function set(patch: Record<string, any>) {
  emit('update', { ...props.config, ...patch })
}

const setName = (value: string) => set({ name: value.trim().replace(/^[/#!！]+/, '') })
const setArgs = (next: CommandArg[]) => set({ args: next })

function setArg(index: number, patch: Partial<CommandArg>) {
  setArgs(args.value.map((arg, position) => {
    if (position !== index) return arg
    const next = { ...arg, ...patch }
    // Only text arguments take the rest of the message; only choices have choices.
    if (next.type !== 'text') delete next.rest
    if (next.type !== 'choice') delete next.choices
    if (patch.type && patch.type !== arg.type) delete next.default
    return next
  }))
}

function addArg() {
  const taken = new Set(args.value.map((arg) => arg.name))
  let index = args.value.length + 1
  while (taken.has(t('commandEditor.argName', { n: index }))) index++
  setArgs([...args.value, { name: t('commandEditor.argName', { n: index }), type: 'text' }])
  expanded.value = args.value.length
}

function moveArg(index: number, by: number) {
  const next = [...args.value]
  const [item] = next.splice(index, 1)
  next.splice(index + by, 0, item)
  setArgs(next)
}

const removeArg = (index: number) => setArgs(args.value.filter((_, position) => position !== index))

/** The row whose extra settings (default, choices, note) are open. */
const expanded = ref<number>()

function defaultText(arg: CommandArg) {
  return arg.default === undefined ? '' : String(arg.default)
}

function setDefault(index: number, arg: CommandArg, text: string) {
  if (!text.trim()) return setArg(index, { default: undefined })
  if (arg.type === 'number' && Number.isFinite(Number(text))) return setArg(index, { default: Number(text) })
  if (arg.type === 'boolean') return setArg(index, { default: /^(是|true|yes|on|1)$/i.test(text.trim()) })
  setArg(index, { default: text })
}

const label = (arg: CommandArg) => (arg.type === 'text' ? '' : `:${t(`commandEditor.short.${arg.type}`, { choices: (arg.choices ?? []).join('|') })}`)
const usage = computed(() => {
  const parts = args.value.map((arg) => {
    const body = `${arg.name}${label(arg)}${arg.rest ? '...' : ''}`
    return arg.optional || (arg.default !== undefined && arg.default !== '') ? `[${body}]` : `<${body}>`
  })
  return [`${shownPrefix.value}${props.config.name ?? ''}`, ...parts].join(' ')
})

// ---- try a message ----

const sample = ref('')
const result = ref<TryResult>()
let timer: ReturnType<typeof setTimeout> | undefined
watch(() => [sample.value, JSON.stringify(props.config)], () => {
  clearTimeout(timer)
  if (!sample.value.trim()) {
    result.value = undefined
    return
  }
  timer = setTimeout(async () => {
    try {
      result.value = await call<TryResult>('bots.tryCommand', {
        name: String(props.config.name ?? ''),
        aliases: props.config.aliases ?? [],
        prefixes: prefixes.value,
        args: args.value.map(({ description: _, ...arg }) => arg),
        text: sample.value,
        ...(props.bots[0] ? { bot: props.bots[0] } : {}),
      })
    } catch {
      result.value = undefined
    }
  }, 250)
})

/** Fills the try box with a message that should run the command. */
function suggest() {
  const value = (arg: CommandArg) => (arg.type === 'number' ? '85' : arg.type === 'boolean' ? '是' : arg.type === 'user' ? '@10001' : arg.type === 'choice' ? arg.choices?.[0] ?? '' : t('commandEditor.sampleText'))
  sample.value = [`${shownPrefix.value}${props.config.name ?? ''}`, ...args.value.filter((arg) => !arg.optional).map(value)].join(' ')
}

const shownValue = (value: unknown) => (value === true ? t('commandEditor.yes') : value === false ? t('commandEditor.no') : String(value))
</script>

<template>
  <div class="command-editor">
    <div class="field-label">{{ t('commandEditor.command') }}</div>
    <div class="name-row">
      <Select
        class="prefix"
        size="small"
        multiple
        tag
        filterable
        :max-tag-count="1"
        :value="prefixes"
        :placeholder="t('commandEditor.followBot', { prefix: botPrefixes.join(' ') })"
        :options="['/', '#', '!', '.', '！'].map((value) => ({ value, label: value }))"
        :aria-label="t('commandEditor.prefixes')"
        @update:value="(next: string[]) => set({ prefixes: next.map((item) => item.trim()).filter(Boolean) })"
      />
      <Input
        class="name"
        size="small"
        :value="config.name ?? ''"
        :placeholder="t('commandEditor.namePlaceholder')"
        :aria-label="t('commandEditor.command')"
        @update:value="setName"
      />
    </div>
    <p class="muted small hint">
      {{ followsBot ? t('commandEditor.followsBotHint', { prefix: botPrefixes.join(' ') }) : t('commandEditor.ownPrefixHint') }}
    </p>

    <div class="field-label">{{ t('commandEditor.aliases') }}</div>
    <TagsInput
      size="small"
      :value="config.aliases ?? []"
      @update:value="(next: string[]) => set({ aliases: next.map((item) => item.trim().replace(/^[/#!！]+/, '')).filter(Boolean) })"
    />

    <div class="field-label args-title">
      {{ t('commandEditor.args') }}
      <Button size="tiny" quaternary @click="addArg" icon="i-lucide-plus">
        {{ t('commandEditor.addArg') }}
      </Button>
    </div>
    <p v-if="!args.length" class="muted small hint">{{ t('commandEditor.noArgs') }}</p>
    <div v-for="(arg, index) in args" :key="index" class="arg" :class="{ open: expanded === index, bad: result?.arg === arg.name }">
      <div class="arg-row">
        <Input class="arg-name" size="small" :value="arg.name" :aria-label="t('commandEditor.argNameLabel')" @update:value="(value: string) => setArg(index, { name: value.trim() })" />
        <Select class="arg-type" size="small" :value="arg.type" :options="typeOptions" @update:value="(value: ArgType) => setArg(index, { type: value })" />
        <Checkbox size="small" :checked="!arg.optional" @update:checked="(value: boolean) => setArg(index, { optional: !value })">{{ t('commandEditor.required') }}</Checkbox>
        <span class="arg-tools">
          <Button quaternary circle size="tiny" :disabled="index === 0" :aria-label="t('commandEditor.moveUp')" @click="moveArg(index, -1)" icon="i-lucide-arrow-up" />
          <Button quaternary circle size="tiny" :disabled="index === args.length - 1" :aria-label="t('commandEditor.moveDown')" @click="moveArg(index, 1)" icon="i-lucide-arrow-down" />
          <Button quaternary circle size="tiny" :aria-label="t('commandEditor.more')" :aria-expanded="expanded === index" @click="expanded = expanded === index ? undefined : index" icon="i-lucide-chevron-down" />
          <Button quaternary circle size="tiny" type="error" :aria-label="t('common.delete')" @click="removeArg(index)" icon="i-lucide-trash-2" />
        </span>
      </div>
      <div v-if="expanded === index" class="arg-more">
        <TagsInput
          v-if="arg.type === 'choice'"
          size="small"
          :value="arg.choices ?? []"
          @update:value="(next: string[]) => setArg(index, { choices: next })"
        />
        <Input
          v-if="arg.optional && arg.type !== 'user'"
          size="small"
          :value="defaultText(arg)"
          :placeholder="t('commandEditor.defaultPlaceholder')"
          @update:value="(text: string) => setDefault(index, arg, text)"
        />
        <Input size="small" :value="arg.description ?? ''" :placeholder="t('commandEditor.notePlaceholder')" @update:value="(value: string) => setArg(index, { description: value })" />
        <Checkbox v-if="arg.type === 'text'" size="small" :checked="!!arg.rest" @update:checked="(value: boolean) => setArg(index, { rest: value })">
          {{ t('commandEditor.rest') }}
        </Checkbox>
      </div>
    </div>

    <div class="usage">
      <span class="muted small">{{ t('commandEditor.usage') }}</span>
      <code>{{ usage }}</code>
    </div>

    <div class="try">
      <Input v-model:value="sample" size="small" clearable :placeholder="t('commandEditor.tryPlaceholder')">
        <template #suffix>
          <Button v-if="!sample" text size="tiny" type="primary" @click="suggest">{{ t('commandEditor.suggest') }}</Button>
        </template>
      </Input>
      <div v-if="result" class="try-result" aria-live="polite">
        <template v-if="!result.matched">
          <Tag size="small">{{ t(`commandEditor.noMatch.${result.reason}`) }}</Tag>
        </template>
        <template v-else-if="result.ok">
          <Tag size="small" type="success">{{ t('commandEditor.matched') }}</Tag>
          <span v-for="(value, name) in result.values" :key="name" class="value"><span class="muted">{{ name }} =</span> {{ shownValue(value) }}</span>
          <span v-if="!Object.keys(result.values ?? {}).length" class="muted small">{{ t('commandEditor.noValues') }}</span>
        </template>
        <template v-else>
          <Tag size="small" type="warning">{{ t('commandEditor.badArgs') }}</Tag>
          <span class="small">{{ result.arg ? t('commandEditor.badArg', { name: result.arg }) : result.error }}</span>
          <span v-if="config.usageHint !== false" class="muted small">{{ t('commandEditor.repliesUsage') }}</span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.command-editor {
  margin-bottom: 14px;
}

.field-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg);
  margin: 0 0 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.name-row {
  display: flex;
  gap: 6px;
}

.prefix {
  flex: 0 0 104px;
}

.name {
  flex: 1;
  min-width: 0;
}

.hint {
  margin: 4px 0 12px;
  line-height: 1.5;
}

.args-title {
  margin-top: 14px;
}

.arg {
  border: 1px solid var(--line);
  background: var(--s1);
  border-radius: 8px;
  padding: 6px;
  margin-bottom: 6px;
  transition: border-color 0.15s;
}

.arg.bad {
  border-color: var(--warn);
}

.arg-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.arg-name {
  flex: 1 1 90px;
  min-width: 80px;
}

.arg-type {
  flex: 0 0 96px;
}

.arg-tools {
  display: inline-flex;
  margin-left: auto;
}

.chevron {
  transition: transform 0.15s;
}

.arg.open .chevron {
  transform: rotate(180deg);
}

.arg-more {
  display: grid;
  gap: 6px;
  margin-top: 6px;
}

.usage {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 10px 0 8px;
  flex-wrap: wrap;
}

.usage code {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12.5px;
  word-break: break-all;
}

.try-result {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin-top: 6px;
  font-size: 13px;
}

.value {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12.5px;
}

@media (prefers-reduced-motion: reduce) {
  .arg, .chevron {
    transition: none;
  }
}
</style>

<style scoped src="./panel.css"></style>
