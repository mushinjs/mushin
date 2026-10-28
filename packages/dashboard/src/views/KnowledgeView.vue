<script setup lang="ts">
import { AddOutline, ArrowBackOutline, LibraryOutline } from '@vicons/ionicons5'
import {
  NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NGrid, NGridItem, NIcon, NInput, NModal, NSpace, NSpin, NTabPane, NTabs, NTag, useMessage,
} from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { call, on } from '../api'
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
const message = useMessage()
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
      <div class="page-header">
        <div>
          <h1>{{ t('nav.knowledge') }}</h1>
          <p class="page-lead">{{ t('knowledge.lead') }}</p>
        </div>
        <NButton v-if="available" type="primary" data-agent-target="knowledge.add" @click="openCreate">
          <template #icon><NIcon><AddOutline /></NIcon></template>
          {{ t('knowledge.add') }}
        </NButton>
      </div>

      <NSpin :show="loading">
        <NAlert v-if="available === false" type="warning" :title="t('knowledge.unavailable')">
          {{ t('knowledge.unavailableHint') }}
          <RouterLink to="/plugins?highlight=@mushin/plugin-knowledge">{{ t('permissions.openPlugins') }}</RouterLink>
        </NAlert>
        <NCard v-else-if="!bases.length && !loading">
          <NEmpty :description="t('knowledge.empty')">
            <template #extra>
              <NButton type="primary" @click="openCreate">{{ t('knowledge.add') }}</NButton>
            </template>
          </NEmpty>
        </NCard>
        <NGrid v-else cols="1 700:2 1100:3" responsive="self" :x-gap="16" :y-gap="16">
          <NGridItem v-for="item in bases" :key="item.id">
            <RouterLink :to="`/knowledge/${item.id}/docs`" class="card-link">
              <NCard size="small" class="base" hoverable>
                <div class="head">
                  <NIcon size="28" class="icon"><LibraryOutline /></NIcon>
                  <div class="title">
                    <strong>{{ item.name }}</strong>
                    <span class="muted desc">{{ item.description || t('knowledge.noDescription') }}</span>
                  </div>
                </div>
                <div class="meta">
                  <NTag size="small" :bordered="false">{{ t('knowledge.docCount', { count: item.docs }) }}</NTag>
                  <NTag size="small" :bordered="false">{{ t('knowledge.chunkCount', { count: item.chunks }) }}</NTag>
                  <NTag size="small" :bordered="false" :type="item.model ? 'info' : 'default'" class="mono">{{ item.model || t('knowledge.keywordsOnly') }}</NTag>
                  <NTag v-if="item.busy" size="small" :bordered="false" type="warning">{{ t('knowledge.busy') }}</NTag>
                  <NTag v-if="item.candidates" size="small" :bordered="false" type="success">{{ t('knowledge.candidateCount', { count: item.candidates }) }}</NTag>
                </div>
                <div class="muted used">
                  {{ item.bots.length ? t('knowledge.linkedBots', { bots: botNames(item.bots) }) : t('knowledge.noBots') }}
                </div>
              </NCard>
            </RouterLink>
          </NGridItem>
        </NGrid>
      </NSpin>
    </template>

    <template v-else>
      <div class="page-header">
        <div class="detail-title">
          <NButton quaternary circle :aria-label="t('common.back')" @click="router.push('/knowledge')">
            <template #icon><NIcon><ArrowBackOutline /></NIcon></template>
          </NButton>
          <div>
            <h1>{{ base?.name ?? id }}</h1>
            <p v-if="base" class="page-lead">
              {{ t('knowledge.docCount', { count: base.docs }) }} · {{ t('knowledge.chunkCount', { count: base.chunks }) }} ·
              <span class="mono">{{ base.model ? `${base.model}（${t('knowledge.embedded', { done: base.embedded, total: base.chunks })}）` : t('knowledge.keywordsOnly') }}</span>
            </p>
          </div>
        </div>
      </div>
      <NSpin :show="loading && !base">
        <NAlert v-if="!loading && !base" type="warning">{{ t('knowledge.notFound') }}</NAlert>
        <NTabs v-if="base" :value="tab" type="line" animated @update:value="(next: string) => router.replace(`/knowledge/${id}/${next}`)">
          <NTabPane name="docs" :tab="t('knowledge.tab.docs')" data-agent-target="knowledge.docs">
            <KnowledgeDocs :base="base" />
          </NTabPane>
          <NTabPane name="chunks" :tab="t('knowledge.tab.chunks')" data-agent-target="knowledge.chunks">
            <KnowledgeChunks :base="base" />
          </NTabPane>
          <NTabPane name="search" :tab="t('knowledge.tab.search')" data-agent-target="knowledge.search">
            <KnowledgeSearch :base="base" />
          </NTabPane>
          <NTabPane name="graph" :tab="t('knowledge.tab.graph')" data-agent-target="knowledge.graph">
            <KnowledgeGraph v-if="tab === 'graph'" :base="base" />
          </NTabPane>
          <NTabPane name="learn" :tab="base.candidates ? `${t('knowledge.tab.learn')} (${base.candidates})` : t('knowledge.tab.learn')" data-agent-target="knowledge.learn">
            <KnowledgeLearn :base="base" />
          </NTabPane>
          <NTabPane name="settings" :tab="t('knowledge.tab.settings')" data-agent-target="knowledge.settings">
            <KnowledgeSettings :base="base" @deleted="router.push('/knowledge')" />
          </NTabPane>
        </NTabs>
      </NSpin>
    </template>

    <NModal v-model:show="showCreate" preset="card" :title="t('knowledge.add')" style="width: min(560px, 96vw)">
      <NForm label-placement="top">
        <NFormItem :label="t('common.name')" required>
          <NInput v-model:value="draft.name" :maxlength="60" :placeholder="t('knowledge.namePlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('knowledge.description')">
          <NInput v-model:value="draft.description" :maxlength="500" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" />
        </NFormItem>
        <EmbeddingPicker v-model:provider="draft.provider" v-model:model="draft.model" />
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="creating" @click="create">{{ t('common.create') }}</NButton>
        </NSpace>
      </template>
    </NModal>
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
  color: var(--n-color-target, #18a058);
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
