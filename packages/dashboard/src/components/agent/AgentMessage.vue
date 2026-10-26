<script setup lang="ts">
import { CheckmarkCircle, CopyOutline, EllipseOutline } from '@vicons/ionicons5'
import { NButton, NIcon, NTag } from 'naive-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useTheme } from '../../theme'
import { nextDiagramId, renderSegments, type Segment } from './markdown'

const props = defineProps<{ text: string; streaming?: boolean }>()

const { t } = useI18n()
const router = useRouter()
const { isDark } = useTheme()

// While streaming, re-render at most every 120 ms so long replies stay smooth.
const source = ref(props.text)
let timer: ReturnType<typeof setTimeout> | undefined
watch(() => props.text, (text) => {
  if (!props.streaming) {
    source.value = text
    return
  }
  timer ??= setTimeout(() => {
    timer = undefined
    source.value = props.text
  }, 120)
})
watch(() => props.streaming, (streaming) => {
  if (!streaming) source.value = props.text
})
onBeforeUnmount(() => clearTimeout(timer))

const segments = computed<Segment[]>(() => renderSegments(source.value))

const copied = ref<number>()
async function copy(code: string, index: number) {
  try {
    await navigator.clipboard.writeText(code)
    copied.value = index
    setTimeout(() => {
      if (copied.value === index) copied.value = undefined
    }, 1500)
  } catch {}
}

/** Dashboard links inside replies stay in the app. */
function onClick(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest('a')
  const href = link?.getAttribute('href')
  if (href?.startsWith('/') && !event.metaKey && !event.ctrlKey) {
    event.preventDefault()
    router.push(href)
  }
}

// Mermaid is about a megabyte, so it loads the first time a reply has a diagram.
let mermaidLoader: Promise<typeof import('mermaid')['default']> | undefined
const diagrams = ref<Record<string, { svg?: string; error?: string }>>({})

async function renderDiagram(code: string, dark: boolean) {
  const key = `${dark ? 'd' : 'l'}:${code}`
  if (diagrams.value[key]) return
  diagrams.value = { ...diagrams.value, [key]: {} }
  try {
    mermaidLoader ??= import('mermaid').then((module) => module.default)
    const mermaid = await mermaidLoader
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'inherit' })
    const { svg } = await mermaid.render(nextDiagramId(), code)
    diagrams.value = { ...diagrams.value, [key]: { svg } }
  } catch (error) {
    diagrams.value = { ...diagrams.value, [key]: { error: (error as Error)?.message ?? String(error) } }
  }
}

const diagramOf = (code: string) => diagrams.value[`${isDark.value ? 'd' : 'l'}:${code}`]

watch([segments, isDark, () => props.streaming], () => {
  // A diagram is drawn once its block is complete.
  if (props.streaming) return
  for (const segment of segments.value) {
    if (segment.kind === 'mermaid') renderDiagram(segment.code, isDark.value)
  }
}, { immediate: true })

const statusType = { ok: 'success', warning: 'warning', error: 'error', info: 'info' } as const
</script>

<template>
  <div class="agent-md" @click="onClick">
    <template v-for="(segment, index) in segments" :key="index">
      <div v-if="segment.kind === 'html'" class="md" v-html="segment.html" />
      <div v-else-if="segment.kind === 'code'" class="code-block">
        <div class="code-head">
          <span>{{ segment.lang || t('agentMessage.code') }}</span>
          <NButton size="tiny" quaternary @click="copy(segment.code, index)">
            <template #icon><NIcon><CheckmarkCircle v-if="copied === index" /><CopyOutline v-else /></NIcon></template>
            {{ copied === index ? t('agentMessage.copied') : t('agentMessage.copy') }}
          </NButton>
        </div>
        <pre class="hljs mono"><code v-html="segment.html" /></pre>
      </div>
      <div v-else-if="segment.kind === 'mermaid'" class="diagram">
        <div v-if="diagramOf(segment.code)?.svg" class="diagram-svg" v-html="diagramOf(segment.code)!.svg" />
        <template v-else-if="diagramOf(segment.code)?.error">
          <div class="diagram-error">{{ t('agentMessage.diagramFailed') }}</div>
          <pre class="mono">{{ segment.code }}</pre>
        </template>
        <div v-else class="diagram-loading">{{ t('agentMessage.diagramLoading') }}</div>
      </div>
      <div v-else-if="segment.kind === 'card'" class="card" :class="segment.card.status">
        <div class="card-head">
          <div>
            <div class="card-title">{{ segment.card.title }}</div>
            <div v-if="segment.card.subtitle" class="card-subtitle">{{ segment.card.subtitle }}</div>
          </div>
          <NTag v-if="segment.card.status" size="small" :type="statusType[segment.card.status]" :bordered="false">
            {{ t(`agentMessage.status.${segment.card.status}`) }}
          </NTag>
        </div>
        <dl v-if="segment.card.fields?.length" class="card-fields">
          <template v-for="field in segment.card.fields" :key="field.label">
            <dt>{{ field.label }}</dt>
            <dd>{{ field.value }}</dd>
          </template>
        </dl>
        <div v-if="segment.card.actions?.length" class="card-actions">
          <NButton v-for="action in segment.card.actions" :key="action.path" size="small" secondary @click="router.push(action.path)">{{ action.label }}</NButton>
        </div>
      </div>
      <ul v-else-if="segment.kind === 'steps'" class="steps">
        <li v-for="(step, stepIndex) in segment.steps" :key="stepIndex" :class="{ done: step.done }">
          <NIcon :color="step.done ? '#18a058' : undefined"><CheckmarkCircle v-if="step.done" /><EllipseOutline v-else /></NIcon>
          <span>{{ step.text }}</span>
        </li>
      </ul>
      <pre v-else class="mono raw">{{ segment.code }}</pre>
    </template>
  </div>
</template>

<style scoped>
.agent-md {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  white-space: normal;
}

.md :deep(p) {
  margin: 0 0 6px;
}

.md :deep(p:last-child),
.md :deep(ul:last-child),
.md :deep(ol:last-child) {
  margin-bottom: 0;
}

.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4) {
  font-size: 15px;
  margin: 8px 0 4px;
}

.md :deep(ul),
.md :deep(ol) {
  margin: 0 0 6px;
  padding-left: 20px;
}

.md :deep(code) {
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12.5px;
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.16);
}

.md :deep(pre) {
  overflow-x: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.1);
}

.md :deep(pre code) {
  padding: 0;
  background: none;
}

.md :deep(table) {
  border-collapse: collapse;
  font-size: 13px;
  display: block;
  overflow-x: auto;
  margin: 4px 0;
}

.md :deep(th),
.md :deep(td) {
  border: 1px solid rgba(127, 127, 127, 0.25);
  padding: 4px 8px;
  text-align: left;
}

.md :deep(th) {
  background: rgba(127, 127, 127, 0.08);
}

.md :deep(blockquote) {
  margin: 0 0 6px;
  padding-left: 10px;
  border-left: 3px solid rgba(127, 127, 127, 0.35);
  opacity: 0.85;
}

.md :deep(a) {
  color: #5a6fd6;
}

.code-block {
  border: 1px solid rgba(127, 127, 127, 0.2);
  border-radius: 8px;
  overflow: hidden;
}

.code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px 2px 10px;
  font-size: 12px;
  opacity: 0.8;
  background: rgba(127, 127, 127, 0.08);
}

.code-block pre {
  margin: 0;
  padding: 8px 10px;
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.55;
}

.diagram {
  border: 1px solid rgba(127, 127, 127, 0.2);
  border-radius: 8px;
  padding: 8px;
  overflow-x: auto;
}

.diagram-svg :deep(svg) {
  max-width: 100%;
  height: auto;
}

.diagram-loading,
.diagram-error {
  font-size: 12px;
  opacity: 0.65;
}

.card {
  border: 1px solid rgba(127, 127, 127, 0.25);
  border-left-width: 3px;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.card.ok { border-left-color: #18a058; }
.card.warning { border-left-color: #f0a020; }
.card.error { border-left-color: #d03050; }
.card.info { border-left-color: #2080f0; }

.card-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: flex-start;
}

.card-title {
  font-weight: 600;
}

.card-subtitle {
  font-size: 12px;
  opacity: 0.65;
}

.card-fields {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin: 0;
  font-size: 13px;
}

.card-fields dt {
  opacity: 0.6;
}

.card-fields dd {
  margin: 0;
  word-break: break-all;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13.5px;
}

.steps li {
  display: flex;
  gap: 6px;
  align-items: flex-start;
}

.steps li .n-icon {
  margin-top: 3px;
  flex: none;
}

.steps li.done span {
  opacity: 0.65;
}

.raw {
  font-size: 12px;
  opacity: 0.8;
  white-space: pre-wrap;
}

/* Syntax colors readable on both themes. */
.hljs :deep(.hljs-keyword),
.hljs :deep(.hljs-selector-tag),
.hljs :deep(.hljs-built_in) { color: #a35ec9; }
.hljs :deep(.hljs-string),
.hljs :deep(.hljs-attr),
.hljs :deep(.hljs-template-tag) { color: #2f9e6e; }
.hljs :deep(.hljs-number),
.hljs :deep(.hljs-literal) { color: #d0782a; }
.hljs :deep(.hljs-comment) { color: #8a8f98; font-style: italic; }
.hljs :deep(.hljs-title),
.hljs :deep(.hljs-function),
.hljs :deep(.hljs-section) { color: #3f7fd6; }
.hljs :deep(.hljs-variable),
.hljs :deep(.hljs-property),
.hljs :deep(.hljs-params) { color: #c2566b; }
</style>
