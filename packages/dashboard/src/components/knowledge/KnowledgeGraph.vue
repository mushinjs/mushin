<script setup lang="ts">
import { NAlert, NButton, NCard, NEmpty, NFormItem, NInputNumber, NSlider, NSpace, NSpin, useMessage } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call } from '../../api'
import type { KnowledgeGraph, KnowledgeSummary } from '../../types'
import SimilarityGraph from '../SimilarityGraph.vue'

const props = defineProps<{ base: KnowledgeSummary }>()
const { t } = useI18n()
const router = useRouter()
const message = useMessage()

// Meaning similarity runs high; shared words (without embeddings) much lower.
const byVector = computed(() => !!props.base.model && props.base.embedded === props.base.chunks)
const minSimilarity = ref(byVector.value ? 0.6 : 0.15)
const neighbors = ref(3)
const graph = ref<KnowledgeGraph>()
const loading = ref(false)

async function refresh() {
  loading.value = true
  try {
    graph.value = await call<KnowledgeGraph>('kb.graph', { base: props.base.id, minSimilarity: minSimilarity.value, neighbors: neighbors.value, limit: 500 })
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}
watch(() => props.base.id, refresh, { immediate: true })

const nodes = computed(() => (graph.value?.nodes ?? []).map((node) => ({
  id: node.id, group: node.docTitle || node.doc, label: node.title || node.text.slice(0, 16), detail: node.text,
})))
const edges = computed(() => (graph.value?.edges ?? []).map((edge) => ({ source: edge.source, target: edge.target, value: edge.similarity })))
const lonely = computed(() => {
  const linked = new Set(edges.value.flatMap((edge) => [edge.source, edge.target]))
  return nodes.value.filter((node) => !linked.has(node.id)).length
})

function open(id: string) {
  const node = graph.value?.nodes.find((item) => item.id === id)
  if (node) router.push(`/knowledge/${props.base.id}/chunks?doc=${node.doc}&chunk=${id}`)
}
</script>

<template>
  <div class="graph-tab">
    <p class="muted small">{{ t('knowledge.graph.lead') }}</p>
    <NCard size="small">
      <NSpace align="center" :size="20" :wrap="true">
        <NFormItem :label="t('knowledge.graph.minSimilarity')" label-placement="left" :show-feedback="false">
          <NSlider v-model:value="minSimilarity" :min="0.05" :max="0.95" :step="0.05" style="width: 180px" :format-tooltip="(value: number) => `${Math.round(value * 100)}%`" />
        </NFormItem>
        <NFormItem :label="t('knowledge.graph.neighbors')" label-placement="left" :show-feedback="false">
          <NInputNumber v-model:value="neighbors" :min="1" :max="10" size="small" style="width: 90px" />
        </NFormItem>
        <NButton size="small" :loading="loading" @click="refresh">{{ t('knowledge.graph.redraw') }}</NButton>
      </NSpace>
    </NCard>
    <NAlert v-if="graph && !graph.byVector" type="info" :show-icon="false">{{ t('knowledge.graph.byWords') }}</NAlert>
    <NSpin :show="loading">
      <NCard v-if="graph && !graph.nodes.length" size="small">
        <NEmpty :description="t('knowledge.chunks.empty')" />
      </NCard>
      <NCard v-else-if="graph" size="small">
        <SimilarityGraph :nodes="nodes" :edges="edges" @select="open" />
        <div class="muted small">
          {{ t('knowledge.graph.summary', { nodes: nodes.length, edges: edges.length, lonely }) }}
          <template v-if="graph.total > graph.nodes.length">{{ t('knowledge.graph.limited', { total: graph.total }) }}</template>
        </div>
      </NCard>
    </NSpin>
  </div>
</template>

<style scoped>
.graph-tab {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.small {
  font-size: 12px;
}
</style>
