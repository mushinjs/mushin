<script setup lang="ts">
import { AddOutline, CreateOutline, GitMergeOutline, TrashOutline } from '@vicons/ionicons5'
import { NButton, NCard, NEmpty, NForm, NFormItem, NIcon, NInput, NModal, NPagination, NSelect, NSpace, NSpin, NTag, useDialog, useMessage } from 'naive-ui'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { call, on } from '../../api'
import type { KnowledgeChunk, KnowledgeDoc, KnowledgeSummary } from '../../types'
import IconAction from '../IconAction.vue'

const props = defineProps<{ base: KnowledgeSummary }>()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()

const PAGE = 50
const docs = ref<KnowledgeDoc[]>([])
const chunks = ref<KnowledgeChunk[]>([])
const total = ref(0)
const page = ref(1)
const query = ref('')
const loading = ref(false)

/** Set from links such as a reply's sources: `?doc=` filters, `?chunk=` highlights. */
const doc = computed(() => (route.query.doc ? String(route.query.doc) : ''))
const highlight = computed(() => (route.query.chunk ? String(route.query.chunk) : ''))
const docTitle = (id: string) => docs.value.find((item) => item.id === id)?.title ?? id

async function refresh() {
  loading.value = true
  try {
    const [list, result] = await Promise.all([
      call<KnowledgeDoc[]>('kb.docs.list', { base: props.base.id }),
      call<{ total: number; chunks: KnowledgeChunk[] }>('kb.chunks.list', {
        base: props.base.id,
        ...(doc.value ? { doc: doc.value } : {}),
        ...(query.value.trim() ? { query: query.value.trim() } : {}),
        // A highlighted chunk is found in its document, which rarely has more than a few hundred.
        offset: highlight.value ? 0 : (page.value - 1) * PAGE,
        limit: highlight.value ? 200 : PAGE,
      }),
    ])
    docs.value = list
    chunks.value = result.chunks
    total.value = result.total
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
  if (highlight.value) {
    await nextTick()
    document.getElementById(`chunk-${highlight.value}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
}

watch(() => [props.base.id, doc.value, highlight.value, page.value], refresh, { immediate: true })
let timer: number | undefined
watch(query, () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    page.value = 1
    void refresh()
  }, 300)
})
const offs = [on('knowledge/changed', (event: { base?: string }) => {
  if (!event?.base || event.base === props.base.id) void refresh()
})]
onBeforeUnmount(() => offs.forEach((off) => off()))

const docOptions = computed(() => [{ value: '', label: t('knowledge.chunks.allDocs') }, ...docs.value.map((item) => ({ value: item.id, label: item.title }))])
function setDoc(value: string) {
  page.value = 1
  router.replace({ query: value ? { doc: value } : {} })
}

// ---- editing ----

const showEditor = ref(false)
const editing = ref<KnowledgeChunk | null>(null)
const draft = ref({ title: '', text: '' })
const saving = ref(false)

function openAdd() {
  editing.value = null
  draft.value = { title: '', text: '' }
  showEditor.value = true
}

function openEdit(chunk: KnowledgeChunk) {
  editing.value = chunk
  draft.value = { title: chunk.title, text: chunk.text }
  showEditor.value = true
}

async function save() {
  if (!draft.value.text.trim()) return
  saving.value = true
  try {
    if (editing.value) await call('kb.chunks.update', { id: editing.value.id, title: draft.value.title, text: draft.value.text })
    else await call('kb.chunks.add', { base: props.base.id, text: draft.value.text, ...(draft.value.title.trim() ? { title: draft.value.title.trim() } : {}) })
    showEditor.value = false
    message.success(t('common.saved'))
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

async function merge(chunk: KnowledgeChunk) {
  try {
    await call('kb.chunks.merge', { id: chunk.id })
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  }
}

function remove(chunk: KnowledgeChunk) {
  dialog.warning({
    title: t('knowledge.chunks.deleteTitle'),
    content: chunk.text.slice(0, 120),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await call('kb.chunks.remove', { id: chunk.id })
      await refresh()
    },
  })
}

/** Who added a chunk, from what the chat commands, learning and this page keep in its meta. */
function originOf(chunk: KnowledgeChunk) {
  const meta = chunk.meta ?? {}
  if (meta.by === 'dashboard') return t('knowledge.chunks.origin.dashboard')
  if (meta.candidate) return t('knowledge.chunks.origin.learned', { channel: meta.channel })
  if (meta.from) return t('knowledge.chunks.origin.collected', { user: meta.fromName || meta.from, by: meta.userName || meta.user })
  if (meta.user) return t('knowledge.chunks.origin.remembered', { user: meta.userName || meta.user, channel: meta.channel })
  return ''
}

/** Whether the next chunk in the list is from the same document, so the two can be joined. */
const canMerge = (index: number) => chunks.value[index + 1]?.doc === chunks.value[index].doc
</script>

<template>
  <div class="chunks">
    <div class="toolbar">
      <NSelect :value="doc" :options="docOptions" class="doc-select" @update:value="setDoc" />
      <NInput v-model:value="query" clearable :placeholder="t('knowledge.chunks.filter')" class="filter" />
      <NButton type="primary" @click="openAdd">
        <template #icon><NIcon><AddOutline /></NIcon></template>
        {{ t('knowledge.chunks.add') }}
      </NButton>
    </div>
    <div class="muted small">{{ t('knowledge.chunks.total', { count: total }) }}</div>

    <NSpin :show="loading">
      <NCard v-if="!chunks.length && !loading" size="small">
        <NEmpty :description="t('knowledge.chunks.empty')" />
      </NCard>
      <div class="list">
        <NCard v-for="(chunk, index) in chunks" :id="`chunk-${chunk.id}`" :key="chunk.id" size="small" :class="{ highlight: chunk.id === highlight }">
          <div class="head">
            <div class="title">
              <strong>{{ chunk.title || docTitle(chunk.doc) }}</strong>
              <span class="muted small">{{ docTitle(chunk.doc) }} · #{{ chunk.seq + 1 }}</span>
              <NTag v-if="chunk.edited" size="tiny" :bordered="false" type="info">{{ t('knowledge.chunks.edited') }}</NTag>
              <NTag v-if="base.model && !chunk.embedded" size="tiny" :bordered="false" type="warning">{{ t('knowledge.chunks.notEmbedded') }}</NTag>
              <span v-if="originOf(chunk)" class="muted small">{{ originOf(chunk) }}</span>
            </div>
            <NSpace :size="2" :wrap="false">
              <IconAction :icon="CreateOutline" :label="t('common.edit')" @click="openEdit(chunk)" />
              <IconAction :icon="GitMergeOutline" :label="t('knowledge.chunks.merge')" :disabled="!canMerge(index)" @click="merge(chunk)" />
              <IconAction :icon="TrashOutline" :label="t('common.delete')" type="error" @click="remove(chunk)" />
            </NSpace>
          </div>
          <div class="text">{{ chunk.text }}</div>
        </NCard>
      </div>
    </NSpin>
    <NPagination v-if="!highlight && total > PAGE" v-model:page="page" :page-size="PAGE" :item-count="total" />

    <NModal v-model:show="showEditor" preset="card" :title="editing ? t('knowledge.chunks.edit') : t('knowledge.chunks.add')" style="width: min(760px, 96vw)">
      <NForm label-placement="top">
        <NFormItem :label="t('knowledge.chunks.title')" :feedback="t('knowledge.chunks.titleHint')">
          <NInput v-model:value="draft.title" :maxlength="200" />
        </NFormItem>
        <NFormItem :label="t('knowledge.chunks.text')" :feedback="editing ? t('knowledge.chunks.editHint') : t('knowledge.chunks.addHint')">
          <NInput v-model:value="draft.text" type="textarea" :autosize="{ minRows: 6, maxRows: 20 }" />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showEditor = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" :disabled="!draft.text.trim()" @click="save">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.chunks {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.doc-select {
  width: 240px;
}

.filter {
  flex: 1;
  min-width: 180px;
}

.small {
  font-size: 12px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 60px;
}

.highlight {
  outline: 2px solid #18a058;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.text {
  margin-top: 6px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.6;
}
</style>
