<script setup lang="ts">
import { Alert, Button, Card, Form, FormItem, Input, Modal, Spin, TabPane, Tabs, Tag, useToast } from '@mushin/ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { call, on } from '../api'
import EmptyState from '../components/EmptyState.vue'
import PageHeader from '../components/PageHeader.vue'
import EmbeddingPicker from '../components/knowledge/EmbeddingPicker.vue'
import KnowledgeChunks from '../components/knowledge/KnowledgeChunks.vue'
import KnowledgeDocs from '../components/knowledge/KnowledgeDocs.vue'
import KnowledgeGraph from '../components/knowledge/KnowledgeGraph.vue'
import KnowledgeLearn from '../components/knowledge/KnowledgeLearn.vue'
import KnowledgeSearch from '../components/knowledge/KnowledgeSearch.vue'
import KnowledgeSettings from '../components/knowledge/KnowledgeSettings.vue'
import { useAgentSceneStore } from '../stores/agentScene'
import { useDataStore } from '../stores/data'
import type { AppPlugin, KnowledgeSummary } from '../types'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const message = useToast()
const data = useDataStore()

const bases = ref<KnowledgeSummary[]>([])
const available = ref<boolean>()
const loading = ref(true)

const id = computed(() => (route.params.id ? String(route.params.id) : ''))
const tab = computed(() => String(route.params.tab || 'docs'))
const base = computed(() => bases.value.find((item) => item.id === id.value))

async function refresh() {
  try {
    const plugins = await call<AppPlugin[]>('plugins.list')
    available.value = plugins.some((plugin) => plugin.package === '@mushin/plugin-knowledge' && plugin.status === 'active')
    if (!available.value) return
    bases.value = await call<KnowledgeSummary[]>('kb.list')
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void refresh()
  if (!data.loadedBots) data.refreshBots().catch(() => {})
  if (!data.loadedProviders) data.refreshProviders().catch(() => {})
})
// Progress events come often while a document is embedded; counts only change when a stage ends.
const offs = [
  on('knowledge/changed', refresh),
  on('manager/changed', refresh),
  on('knowledge/progress', (progress: { stage: string }) => {
    if (progress.stage === 'done' || progress.stage === 'ready' || progress.stage === 'error') void refresh()
  }),
]
onBeforeUnmount(() => offs.forEach((off) => off()))

// Tells the Agent which base is open and what waits for review.
const agentScene = useAgentSceneStore()
watch([bases, base], () => agentScene.publish(base.value
  ? {
      label: base.value.name,
      state: { base: base.value.name, docs: base.value.docs, chunks: base.value.chunks, candidates: base.value.candidates, embedding: base.value.model || 'none' },
      resource: `kb:${base.value.id}`,
    }
  : { state: { bases: bases.value.length } }), { immediate: true })
onBeforeUnmount(() => agentScene.publish(undefined))

// ---- creating ----

const showCreate = ref(false)
const draft = ref({ name: '', description: '', provider: '', model: '' })
const creating = ref(false)

function openCreate() {
  draft.value = { name: '', description: '', provider: '', model: '' }
  showCreate.value = true
}

async function create() {
  if (!draft.value.name.trim()) {
    message.warning(t('knowledge.nameRequired'))
    return
  }
  if (draft.value.provider && !draft.value.model.trim()) {
    message.warning(t('knowledge.modelRequired'))
    return
  }
  creating.value = true
  try {
    const created = await call<KnowledgeSummary>('kb.create', {
      name: draft.value.name.trim(),
      ...(draft.value.description.trim() ? { description: draft.value.description.trim() } : {}),
      ...(draft.value.provider ? { provider: draft.value.provider, model: draft.value.model.trim() } : {}),
    })
    showCreate.value = false
    await refresh()
    router.push(`/knowledge/${created.id}/docs`)
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    creating.value = false
  }
}

const botNames = (ids: string[]) => ids.map((bot) => data.bots.find((item) => item.id === bot)?.name ?? bot).join('、')
</script>

<template>
  <div class="page">
    <template v-if="!id">
      <PageHeader :title="t('nav.knowledge')" :lead="t('knowledge.lead')">
        <Button v-if="available" type="primary" data-agent-target="knowledge.add" icon="i-lucide-plus" @click="openCreate">
          {{ t('knowledge.add') }}
        </Button>
      </PageHeader>

      <Spin :show="loading">
        <Alert v-if="available === false" type="warning" :title="t('knowledge.unavailable')">
          {{ t('knowledge.unavailableHint') }}
          <RouterLink to="/plugins?highlight=@mushin/plugin-knowledge">{{ t('permissions.openPlugins') }}</RouterLink>
        </Alert>
        <EmptyState v-else-if="!bases.length && !loading" icon="i-lucide-library" :title="t('knowledge.empty')" :hint="t('knowledge.emptyHint')">
          <Button type="primary" @click="openCreate">{{ t('knowledge.add') }}</Button>
        </EmptyState>
        <div v-else class="grid gap-x-[16px] gap-y-[16px] grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          <div v-for="item in bases" :key="item.id">
            <RouterLink :to="`/knowledge/${item.id}/docs`" class="card-link">
              <Card size="small" class="base" hoverable>
                <div class="head">
                  <span class="i-lucide-library icon text-[28px]" />
                  <div class="title">
                    <strong>{{ item.name }}</strong>
                    <span class="muted desc">{{ item.description || t('knowledge.noDescription') }}</span>
                  </div>
                </div>
                <div class="meta">
                  <Tag size="small">{{ t('knowledge.docCount', { count: item.docs }) }}</Tag>
                  <Tag size="small">{{ t('knowledge.chunkCount', { count: item.chunks }) }}</Tag>
                  <Tag size="small" :type="item.model ? 'info' : 'default'" class="mono">{{ item.model || t('knowledge.keywordsOnly') }}</Tag>
                  <Tag v-if="item.busy" size="small" type="warning">{{ t('knowledge.busy') }}</Tag>
                  <Tag v-if="item.candidates" size="small" type="success">{{ t('knowledge.candidateCount', { count: item.candidates }) }}</Tag>
                </div>
                <div class="muted used">
                  {{ item.bots.length ? t('knowledge.linkedBots', { bots: botNames(item.bots) }) : t('knowledge.noBots') }}
                </div>
              </Card>
            </RouterLink>
          </div>
        </div>
      </Spin>
    </template>

    <template v-else>
      <div class="page-header">
        <div class="detail-title">
          <Button quaternary circle :aria-label="t('common.back')" icon="i-lucide-arrow-left" @click="router.push('/knowledge')" />
          <div>
            <h1>{{ base?.name ?? id }}</h1>
            <p v-if="base" class="page-lead">
              {{ t('knowledge.docCount', { count: base.docs }) }} · {{ t('knowledge.chunkCount', { count: base.chunks }) }} ·
              <span class="mono">{{ base.model ? `${base.model}（${t('knowledge.embedded', { done: base.embedded, total: base.chunks })}）` : t('knowledge.keywordsOnly') }}</span>
            </p>
          </div>
        </div>
      </div>
      <Spin :show="loading && !base">
        <Alert v-if="!loading && !base" type="warning">{{ t('knowledge.notFound') }}</Alert>
        <Tabs v-if="base" :value="tab" type="line" @update:value="(next: string) => router.replace(`/knowledge/${id}/${next}`)">
          <TabPane name="docs" :tab="t('knowledge.tab.docs')" data-agent-target="knowledge.docs">
            <KnowledgeDocs :base="base" />
          </TabPane>
          <TabPane name="chunks" :tab="t('knowledge.tab.chunks')" data-agent-target="knowledge.chunks">
            <KnowledgeChunks :base="base" />
          </TabPane>
          <TabPane name="search" :tab="t('knowledge.tab.search')" data-agent-target="knowledge.search">
            <KnowledgeSearch :base="base" />
          </TabPane>
          <TabPane name="graph" :tab="t('knowledge.tab.graph')" data-agent-target="knowledge.graph">
            <KnowledgeGraph v-if="tab === 'graph'" :base="base" />
          </TabPane>
          <TabPane name="learn" :tab="base.candidates ? `${t('knowledge.tab.learn')} (${base.candidates})` : t('knowledge.tab.learn')" data-agent-target="knowledge.learn">
            <KnowledgeLearn :base="base" />
          </TabPane>
          <TabPane name="settings" :tab="t('knowledge.tab.settings')" data-agent-target="knowledge.settings">
            <KnowledgeSettings :base="base" @deleted="router.push('/knowledge')" />
          </TabPane>
        </Tabs>
      </Spin>
    </template>

    <Modal v-model:show="showCreate" :title="t('knowledge.add')" style="width: min(560px, 96vw)">
      <Form>
        <FormItem :label="t('common.name')" required>
          <Input v-model:value="draft.name" :maxlength="60" :placeholder="t('knowledge.namePlaceholder')" />
        </FormItem>
        <FormItem :label="t('knowledge.description')">
          <Input v-model:value="draft.description" :maxlength="500" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" />
        </FormItem>
        <EmbeddingPicker v-model:provider="draft.provider" v-model:model="draft.model" />
      </Form>
      <template #footer>
        <Button @click="showCreate = false">{{ t('common.cancel') }}</Button>
        <Button type="primary" :loading="creating" @click="create">{{ t('common.create') }}</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.card-link {
  color: inherit;
  text-decoration: none;
}

.base {
  height: 100%;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.icon {
  color: var(--ok);
  margin-top: 2px;
}

.title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.desc {
  font-size: 13px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 10px;
}

.used {
  margin-top: 8px;
  font-size: 12px;
}

.detail-title {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
</style>
