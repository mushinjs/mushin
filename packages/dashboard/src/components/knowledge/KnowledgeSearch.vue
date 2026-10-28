<script setup lang="ts">
import { SearchOutline } from '@vicons/ionicons5'
import { NAlert, NButton, NCard, NEmpty, NFormItem, NIcon, NInput, NInputNumber, NSpace, NTag, useMessage } from 'naive-ui'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { call, on } from '../../api'
import { useDataStore } from '../../stores/data'
import type { KnowledgeHit, KnowledgeSummary } from '../../types'

const props = defineProps<{ base: KnowledgeSummary }>()
const { t } = useI18n()
const message = useMessage()
const data = useDataStore()

const query = ref('')
const topK = ref(props.base.topK)
const minScore = ref(props.base.minScore)
const hits = ref<KnowledgeHit[]>()
const semantic = ref(false)
const warnings = ref<string[]>([])
const searching = ref(false)

watch(() => props.base.id, () => {
  topK.value = props.base.topK
  minScore.value = props.base.minScore
  hits.value = undefined
})

async function search() {
  if (!query.value.trim()) return
  searching.value = true
  try {
    const result = await call<{ hits: KnowledgeHit[]; semantic: boolean; warnings: string[] }>('kb.search', {
      query: query.value.trim(), bases: [props.base.id], topK: topK.value ?? props.base.topK, minScore: minScore.value ?? 0,
    })
    hits.value = result.hits
    semantic.value = result.semantic
    warnings.value = result.warnings
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    searching.value = false
  }
}

const pct = (value: number | undefined) => (value === undefined ? '–' : `${Math.round(value * 100)}%`)

// ---- using the base in flows ----

interface FlowChoice { id: string; name: string; bots: string[]; llmChat: boolean; uses: boolean }
const flows = ref<FlowChoice[]>([])
const adding = ref('')

async function refreshFlows() {
  try {
    flows.value = await call<FlowChoice[]>('kb.flowChoices', { base: props.base.id })
  } catch {}
}
onMounted(refreshFlows)
const off = on('flows/changed', refreshFlows)
onBeforeUnmount(off)

async function useInFlow(flow: FlowChoice) {
  adding.value = flow.id
  try {
    await call('kb.useInFlow', { flow: flow.id, bases: [props.base.id] })
    message.success(t('knowledge.search.used', { name: flow.name }))
    await refreshFlows()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    adding.value = ''
  }
}

const botNames = (ids: string[]) => ids.map((bot) => data.bots.find((item) => item.id === bot)?.name ?? bot).join('、')
</script>

<template>
  <div class="search">
    <NCard size="small" :title="t('knowledge.search.title')">
      <div class="form">
        <NInput v-model:value="query" :placeholder="t('knowledge.search.placeholder')" clearable class="query" @keyup.enter="search" />
        <NButton type="primary" :loading="searching" :disabled="!query.trim()" @click="search">
          <template #icon><NIcon><SearchOutline /></NIcon></template>
          {{ t('knowledge.search.run') }}
        </NButton>
      </div>
      <NSpace class="options" :size="16">
        <NFormItem :label="t('knowledge.settings.topK')" label-placement="left" :show-feedback="false">
          <NInputNumber v-model:value="topK" :min="1" :max="20" size="small" style="width: 90px" />
        </NFormItem>
        <NFormItem :label="t('knowledge.settings.minScore')" label-placement="left" :show-feedback="false">
          <NInputNumber v-model:value="minScore" :min="0" :max="1" :step="0.05" size="small" style="width: 100px" />
        </NFormItem>
      </NSpace>
      <p class="muted small">{{ t('knowledge.search.scoreHint') }}</p>
    </NCard>

    <NAlert v-for="warning in warnings" :key="warning" type="warning">{{ warning }}</NAlert>
    <template v-if="hits">
      <div class="muted small">{{ semantic ? t('knowledge.search.bothWays') : t('knowledge.search.keywordsOnly') }}</div>
      <NCard v-if="!hits.length" size="small">
        <NEmpty :description="t('knowledge.search.none')" />
      </NCard>
      <NCard v-for="(hit, index) in hits" :key="hit.id" size="small">
        <div class="hit-head">
          <strong>[{{ index + 1 }}] {{ hit.title || hit.docTitle }}</strong>
          <RouterLink class="small" :to="`/knowledge/${base.id}/chunks?doc=${hit.doc}&chunk=${hit.id}`">{{ hit.docTitle }}</RouterLink>
        </div>
        <div class="scores">
          <NTag size="small" type="success" :bordered="false">{{ t('knowledge.search.score') }} {{ pct(hit.score) }}</NTag>
          <NTag size="small" :bordered="false">{{ t('knowledge.search.similarity') }} {{ pct(hit.similarity) }}</NTag>
          <NTag size="small" :bordered="false">{{ t('knowledge.search.coverage') }} {{ pct(hit.coverage) }}</NTag>
          <NTag size="small" :bordered="false">{{ t('knowledge.search.ranks', { keyword: hit.ranks.keyword ?? '–', vector: hit.ranks.vector ?? '–' }) }}</NTag>
        </div>
        <div class="text">{{ hit.text }}</div>
      </NCard>
    </template>

    <NCard size="small" :title="t('knowledge.search.flowsTitle')">
      <p class="muted small">{{ t('knowledge.search.flowsHint') }}</p>
      <NEmpty v-if="!flows.length" :description="t('knowledge.search.noFlows')" />
      <div v-for="flow in flows" :key="flow.id" class="flow">
        <div class="flow-info">
          <RouterLink :to="`/flows/${flow.id}`">{{ flow.name }}</RouterLink>
          <NTag v-if="flow.llmChat" size="tiny" :bordered="false" type="info">{{ t('knowledge.search.llmChat') }}</NTag>
          <span v-if="flow.bots.length" class="muted small">{{ botNames(flow.bots) }}</span>
        </div>
        <NTag v-if="flow.uses" size="small" type="success" :bordered="false">{{ t('knowledge.search.inUse') }}</NTag>
        <NButton v-else size="small" :loading="adding === flow.id" @click="useInFlow(flow)">{{ t('knowledge.search.use') }}</NButton>
      </div>
    </NCard>
  </div>
</template>

<style scoped>
.search {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.form {
  display: flex;
  gap: 8px;
}

.query {
  flex: 1;
}

.options {
  margin-top: 10px;
}

.small {
  font-size: 12px;
}

.hit-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}

.scores {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

.text {
  margin-top: 6px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.6;
}

.flow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid rgba(128, 128, 128, 0.15);
}

.flow-info {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}
</style>
