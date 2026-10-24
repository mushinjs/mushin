<script setup lang="ts">
import { AddOutline, GitNetworkOutline, TrashOutline } from '@vicons/ionicons5'
import {
  NButton, NCard, NEmpty, NForm, NFormItem, NGrid, NGridItem, NIcon, NInput, NModal, NSelect, NTag, useDialog, useMessage,
} from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call, on } from '../api'
import { flowTemplates } from '../flow'
import { useDataStore } from '../stores/data'
import type { FlowDoc, FlowSummary } from '../types'
import { formatTime } from '../utils'

const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const data = useDataStore()
const flows = ref<FlowSummary[]>([])
const loaded = ref(false)

async function refresh() {
  flows.value = await call<FlowSummary[]>('flows.list')
  loaded.value = true
}

onMounted(() => {
  refresh().catch((error) => message.error(error.message))
  if (!data.loadedBots) data.refreshBots().catch(() => {})
})
const off = on('flows/changed', () => refresh().catch(() => {}))
onBeforeUnmount(off)

const botName = (id: string) => data.bots.find((bot) => bot.id === id)?.name ?? id
const botOptions = computed(() => data.bots.map((bot) => ({ label: bot.name, value: bot.id })))

const showCreate = ref(false)
const creating = ref(false)
const form = ref({ name: '', template: 'keyword', bots: [] as string[] })

function openCreate() {
  form.value = { name: '', template: 'keyword', bots: [] }
  showCreate.value = true
}

async function create() {
  if (!form.value.name.trim()) return
  const template = flowTemplates.find((item) => item.id === form.value.template) ?? flowTemplates[0]
  creating.value = true
  try {
    const flow = await call<FlowDoc>('flows.create', {
      name: form.value.name.trim(),
      bots: form.value.bots,
      nodes: template.nodes,
      edges: template.edges,
    })
    showCreate.value = false
    router.push(`/flows/${flow.id}`)
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    creating.value = false
  }
}

function remove(flow: FlowSummary) {
  dialog.warning({
    title: t('common.confirmDelete', { name: flow.name }),
    content: t('flows.deleteHint'),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await call('flows.delete', { id: flow.id })
      message.success(t('common.deleted'))
      await refresh()
    },
  })
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>{{ t('nav.flows') }}</h1>
        <p class="page-lead">{{ t('flows.lead') }}</p>
      </div>
      <NButton type="primary" data-agent-target="flows.add" @click="openCreate">
        <template #icon><NIcon><AddOutline /></NIcon></template>
        {{ t('flows.add') }}
      </NButton>
    </div>

    <NGrid v-if="flows.length" cols="1 640:2 1000:3" :x-gap="16" :y-gap="16">
      <NGridItem v-for="flow in flows" :key="flow.id">
        <NCard hoverable class="flow-card" @click="router.push(`/flows/${flow.id}`)">
          <div class="flow-head">
            <div class="flow-avatar"><NIcon size="22"><GitNetworkOutline /></NIcon></div>
            <div class="flow-title">
              <strong>{{ flow.name }}</strong>
              <span class="sub">{{ t('flows.nodeCount', flow.nodes) }} · {{ formatTime(flow.updatedAt) }}</span>
            </div>
            <NButton quaternary circle size="small" :aria-label="t('common.delete')" @click.stop="remove(flow)">
              <template #icon><NIcon><TrashOutline /></NIcon></template>
            </NButton>
          </div>
          <p v-if="flow.description" class="flow-desc">{{ flow.description }}</p>
          <div class="flow-tags">
            <NTag v-if="flow.errors" type="error" size="small" :bordered="false">{{ t('flows.errorCount', flow.errors) }}</NTag>
            <NTag v-else-if="flow.warnings" type="warning" size="small" :bordered="false">{{ t('flows.warningCount', flow.warnings) }}</NTag>
            <NTag v-for="bot in flow.bots" :key="bot" size="small" :bordered="false" type="info">{{ botName(bot) }}</NTag>
            <span v-if="!flow.bots.length" class="sub">{{ t('flows.runsOnNone') }}</span>
          </div>
        </NCard>
      </NGridItem>
    </NGrid>

    <NCard v-else-if="loaded">
      <NEmpty :description="t('flows.empty')">
        <template #extra>
          <NButton type="primary" @click="openCreate">{{ t('flows.add') }}</NButton>
        </template>
      </NEmpty>
    </NCard>

    <NModal v-model:show="showCreate" preset="card" :title="t('flows.add')" class="create-modal" :style="{ width: 'min(560px, calc(100vw - 32px))' }">
      <NForm label-placement="top" @submit.prevent="create">
        <NFormItem :label="t('common.name')">
          <NInput v-model:value="form.name" :placeholder="t('flows.namePlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('flows.template')">
          <div class="templates">
            <button
              v-for="template in flowTemplates"
              :key="template.id"
              type="button"
              class="template"
              :class="{ active: form.template === template.id }"
              @click="form.template = template.id"
            >
              <strong>{{ t(`flows.templates.${template.id}.title`) }}</strong>
              <span class="sub">{{ t(`flows.templates.${template.id}.description`) }}</span>
            </button>
          </div>
        </NFormItem>
        <NFormItem :label="t('flows.bots')" :feedback="t('flows.botsHint')">
          <NSelect v-model:value="form.bots" multiple :options="botOptions" :placeholder="t('flows.runsOnNone')" />
        </NFormItem>
      </NForm>
      <template #footer>
        <div class="modal-actions">
          <NButton @click="showCreate = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="creating" :disabled="!form.name.trim()" @click="create">{{ t('common.create') }}</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.flow-card {
  cursor: pointer;
}

.flow-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.flow-avatar {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(32, 128, 240, 0.12);
  color: #2080f0;
  flex: none;
}

.flow-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.flow-title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub {
  font-size: 12px;
  opacity: 0.6;
}

.flow-desc {
  margin: 12px 0 0;
  opacity: 0.75;
  font-size: 13px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.flow-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
}

.templates {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  width: 100%;
}

.template {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  font: inherit;
  color: inherit;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(127, 127, 127, 0.3);
  background: transparent;
  cursor: pointer;
}

.template.active {
  border-color: #5b6bc0;
  box-shadow: 0 0 0 2px rgba(91, 107, 192, 0.3);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
