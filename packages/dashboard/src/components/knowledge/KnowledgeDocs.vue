<script setup lang="ts">
import { Button, Card, Empty, Form, FormItem, Input, Modal, Progress, Tag, useConfirm, useToast } from '@mushinjs/ui'
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { call, on } from '../../api'
import type { KnowledgeDoc, KnowledgeProgress, KnowledgeSummary } from '../../types'
import { formatTime } from '../../utils'
import IconAction from '../IconAction.vue'

const props = defineProps<{ base: KnowledgeSummary }>()
const { t } = useI18n()
const message = useToast()
const dialog = useConfirm()

const docs = ref<KnowledgeDoc[]>([])
/** Document id → how far splitting or embedding has got. */
const progress = ref<Record<string, KnowledgeProgress>>({})

async function refresh() {
  try {
    docs.value = await call<KnowledgeDoc[]>('kb.docs.list', { base: props.base.id })
  } catch (error) {
    message.error((error as Error).message)
  }
}

watch(() => props.base.id, refresh, { immediate: true })
const offs = [
  on('knowledge/changed', (event: { base?: string }) => {
    if (!event?.base || event.base === props.base.id) void refresh()
  }),
  on('knowledge/progress', (event: KnowledgeProgress) => {
    if (event.base !== props.base.id || !event.doc) return
    if (event.stage === 'ready' || event.stage === 'error' || event.stage === 'done') {
      delete progress.value[event.doc]
      void refresh()
    } else {
      progress.value[event.doc] = event
    }
  }),
]
onBeforeUnmount(() => offs.forEach((off) => off()))

// ---- adding ----

const fileInput = ref<HTMLInputElement>()
const dragging = ref(false)
const uploading = ref(false)
const MAX_FILE = 20 * 1024 * 1024

function base64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function upload(files: File[]) {
  uploading.value = true
  let added = 0
  for (const file of files) {
    if (file.size > MAX_FILE) {
      message.warning(t('knowledge.docs.tooLarge', { name: file.name }))
      continue
    }
    try {
      await call('kb.docs.add', { base: props.base.id, name: file.name, data: await base64(file) })
      added++
    } catch (error) {
      message.error(`${file.name}: ${(error as Error).message}`)
    }
  }
  uploading.value = false
  if (added) message.success(t('knowledge.docs.added', { count: added }))
  await refresh()
}

function pick(event: Event) {
  const files = [...(event.target as HTMLInputElement).files ?? []]
  ;(event.target as HTMLInputElement).value = ''
  void upload(files)
}

function drop(event: DragEvent) {
  dragging.value = false
  const files = [...event.dataTransfer?.files ?? []]
  if (files.length) void upload(files)
}

const showText = ref(false)
const textDraft = ref({ name: '', text: '' })
const showUrl = ref(false)
const urlDraft = ref('')
const adding = ref(false)

async function addText() {
  if (!textDraft.value.text.trim()) return
  adding.value = true
  try {
    await call('kb.docs.add', { base: props.base.id, name: textDraft.value.name.trim() || undefined, text: textDraft.value.text })
    showText.value = false
    textDraft.value = { name: '', text: '' }
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    adding.value = false
  }
}

async function addUrl() {
  if (!/^https?:\/\//.test(urlDraft.value.trim())) {
    message.warning(t('knowledge.docs.urlInvalid'))
    return
  }
  adding.value = true
  try {
    await call('kb.docs.add', { base: props.base.id, url: urlDraft.value.trim() })
    showUrl.value = false
    urlDraft.value = ''
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    adding.value = false
  }
}

// ---- document actions ----

function reparse(doc: KnowledgeDoc) {
  dialog.warning({
    title: t('knowledge.docs.reparseTitle', { name: doc.title }),
    content: t('knowledge.docs.reparseHint'),
    positiveText: t('knowledge.docs.reparse'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await call('kb.docs.reparse', { id: doc.id })
        await refresh()
      } catch (error) {
        message.error((error as Error).message)
      }
    },
  })
}

function remove(doc: KnowledgeDoc) {
  dialog.warning({
    title: t('common.confirmDelete', { name: doc.title }),
    content: t('knowledge.docs.deleteHint', { count: doc.chunks }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await call('kb.docs.remove', { id: doc.id })
      message.success(t('common.deleted'))
      await refresh()
    },
  })
}

const STATUS_TYPE: Record<string, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
  pending: 'default', parsing: 'info', embedding: 'info', ready: 'success', error: 'error',
}
const percent = (item: KnowledgeProgress) => (item.total ? Math.round((item.done / item.total) * 100) : 0)
</script>

<template>
  <div class="docs">
    <div
      class="drop"
      :class="{ dragging }"
      data-agent-target="knowledge.upload"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="drop"
    >
      <span class="i-lucide-cloud-upload muted text-[32px]" />
      <div>{{ t('knowledge.docs.drop') }}</div>
      <div class="muted small">{{ t('knowledge.docs.formats') }}</div>
      <div class="flex flex-wrap gap-x-3 gap-y-2 items-center justify-center">
        <Button type="primary" :loading="uploading" @click="fileInput?.click()">{{ t('knowledge.docs.pickFiles') }}</Button>
        <Button icon="i-lucide-file-text" @click="showText = true">
          {{ t('knowledge.docs.pasteText') }}
        </Button>
        <Button icon="i-lucide-globe" @click="showUrl = true">
          {{ t('knowledge.docs.addUrl') }}
        </Button>
      </div>
      <input ref="fileInput" type="file" accept=".md,.markdown,.txt,.html,.htm,.pdf,.docx" multiple hidden @change="pick">
    </div>

    <Card v-if="!docs.length" size="small">
      <Empty :description="t('knowledge.docs.empty')" />
    </Card>
    <div v-else class="list">
      <Card v-for="doc in docs" :key="doc.id" size="small">
        <div class="row">
          <div class="info">
            <strong class="name">{{ doc.title }}</strong>
            <div class="meta muted">
              <Tag size="small" :type="STATUS_TYPE[doc.status]">{{ t(`knowledge.docs.status.${doc.status}`) }}</Tag>
              <Tag size="small">{{ t(`knowledge.docs.kind.${doc.kind}`) }}</Tag>
              <template v-if="doc.kind !== 'notes' && doc.kind !== 'learned'">
                <span v-if="doc.format" class="mono">{{ doc.format }}</span>
                <span>{{ t('knowledge.docs.chars', { count: doc.chars.toLocaleString() }) }}</span>
              </template>
              <RouterLink :to="`/knowledge/${base.id}/chunks?doc=${doc.id}`">{{ t('knowledge.chunkCount', { count: doc.chunks }) }}</RouterLink>
              <span>{{ formatTime(doc.updatedAt) }}</span>
              <a v-if="doc.kind === 'url'" :href="doc.source" target="_blank" rel="noopener" class="mono source">{{ doc.source }}</a>
            </div>
            <div v-if="doc.status === 'error'" class="error">{{ doc.error }}</div>
            <Progress v-if="progress[doc.id]" :percentage="percent(progress[doc.id])" processing class="bar">
              {{ t(`knowledge.docs.status.${progress[doc.id].stage}`) }} {{ progress[doc.id].done }}/{{ progress[doc.id].total }}
            </Progress>
          </div>
          <div class="flex gap-[2px] items-center">
            <IconAction v-if="doc.kind === 'file' || doc.kind === 'url' || doc.kind === 'text'" icon="i-lucide-refresh-cw" :label="t('knowledge.docs.reparse')" @click="reparse(doc)" />
            <IconAction icon="i-lucide-trash-2" :label="t('common.delete')" type="error" @click="remove(doc)" />
          </div>
        </div>
      </Card>
    </div>

    <Modal v-model:show="showText" :title="t('knowledge.docs.pasteText')" style="width: min(760px, 96vw)">
      <Form>
        <FormItem :label="t('knowledge.docs.title')">
          <Input v-model:value="textDraft.name" :maxlength="120" />
        </FormItem>
        <FormItem :label="t('knowledge.docs.text')" :feedback="t('knowledge.docs.textHint')">
          <Input v-model:value="textDraft.text" type="textarea" :autosize="{ minRows: 10, maxRows: 24 }" />
        </FormItem>
      </Form>
      <template #footer>
        <Button @click="showText = false">{{ t('common.cancel') }}</Button>
        <Button type="primary" :loading="adding" :disabled="!textDraft.text.trim()" @click="addText">{{ t('common.add') }}</Button>
      </template>
    </Modal>

    <Modal v-model:show="showUrl" :title="t('knowledge.docs.addUrl')" style="width: min(560px, 96vw)">
      <FormItem :label="t('knowledge.docs.url')" :feedback="t('knowledge.docs.urlHint')">
        <Input v-model:value="urlDraft" placeholder="https://" @keyup.enter="addUrl" />
      </FormItem>
      <template #footer>
        <Button @click="showUrl = false">{{ t('common.cancel') }}</Button>
        <Button type="primary" :loading="adding" @click="addUrl">{{ t('common.add') }}</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.docs {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.drop {
  border: 1px dashed var(--border-color, rgba(128, 128, 128, 0.4));
  border-radius: 8px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}

.drop.dragging {
  border-color: var(--ok);
  background: rgba(24, 160, 88, 0.06);
}

.small {
  font-size: 12px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.name {
  overflow-wrap: anywhere;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 12px;
}

.source {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error {
  color: var(--bad);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.bar {
  max-width: 420px;
}
</style>
