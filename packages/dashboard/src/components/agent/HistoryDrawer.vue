<script setup lang="ts">
import { SearchOutline } from '@vicons/ionicons5'
import { NDrawer, NDrawerContent, NEmpty, NIcon, NInput, NSelect, NSpin, NTag } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../../api'
import { useAgentStore } from '../../stores/agent'
import type { AgentSessionSummary } from '../../types'
import { formatTime } from '../../utils'

const show = defineModel<boolean>('show', { required: true })

const { t, te } = useI18n()
const agent = useAgentStore()
const query = ref('')
const tags = ref<string[]>([])
const results = ref<AgentSessionSummary[]>([])
const loading = ref(false)

const SCENES = ['overview', 'setup', 'providers', 'bots', 'botDetail', 'flows', 'flowEditor', 'personas', 'plugins', 'logs', 'agent']

/** A tag as the user reads it, e.g. `场景：流程编辑器`. */
function tagLabel(tag: string) {
  const [kind, ...rest] = tag.split(':')
  const value = rest.join(':')
  if (kind === 'scene') return `${t('agentHistory.tag.scene')}：${te(`agentScene.name.${value}`) ? t(`agentScene.name.${value}`) : value}`
  if (kind === 'skill') return `${t('agentHistory.tag.skill')}：${agent.skills.find((skill) => skill.id === value)?.name ?? value}`
  if (kind === 'command') return `${t('agentHistory.tag.command')}：/${value}`
  if (kind === 'status') return `${t('agentHistory.tag.status')}：${t(`agentHistory.status.${value}`)}`
  if (kind === 'resource') return `${t('agentHistory.tag.resource')}：${value.split(':')[0]}`
  return tag
}

const tagOptions = computed(() => {
  const seen = new Set<string>([
    ...SCENES.map((scene) => `scene:${scene}`),
    ...agent.skills.map((skill) => `skill:${skill.id}`),
    'status:running',
    ...agent.sessions.flatMap((session) => session.tags.filter((tag) => tag.startsWith('command:'))),
  ])
  return [...seen].map((tag) => ({ label: tagLabel(tag), value: tag }))
})

let seq = 0
async function search() {
  const mine = ++seq
  loading.value = true
  try {
    const list = await call<AgentSessionSummary[]>('agent.search', { query: query.value.trim() || undefined, tags: tags.value.length ? tags.value : undefined })
    if (mine === seq) results.value = list
  } finally {
    if (mine === seq) loading.value = false
  }
}

let timer: ReturnType<typeof setTimeout> | undefined
watch([query, tags], () => {
  clearTimeout(timer)
  timer = setTimeout(() => search().catch(() => {}), 250)
})
watch(show, (open) => {
  if (open) search().catch(() => {})
})

async function openSession(id: string) {
  await agent.load(id)
  show.value = false
}

/** Tags worth showing on a row: where it started and the skills and commands it used. */
function rowTags(session: AgentSessionSummary) {
  return session.tags.filter((tag) => tag.startsWith('skill:') || tag.startsWith('command:')).slice(0, 4)
}
</script>

<template>
  <NDrawer v-model:show="show" :width="440" placement="right">
    <NDrawerContent :title="t('agentHistory.title')" closable :native-scrollbar="false">
      <div class="filters">
        <NInput v-model:value="query" clearable :placeholder="t('agentHistory.search')">
          <template #prefix><NIcon><SearchOutline /></NIcon></template>
        </NInput>
        <NSelect v-model:value="tags" multiple filterable clearable :options="tagOptions" :placeholder="t('agentHistory.tags')" max-tag-count="responsive" />
      </div>
      <NSpin :show="loading" size="small">
        <NEmpty v-if="!results.length && !loading" :description="t('agentHistory.empty')" class="empty" />
        <button
          v-for="session in results"
          :key="session.id"
          type="button"
          class="item"
          :class="{ current: session.id === agent.current }"
          @click="openSession(session.id)"
        >
          <div class="item-head">
            <span class="title">{{ session.title || t('agent.untitled') }}</span>
            <span class="time">{{ formatTime(session.updatedAt) }}</span>
          </div>
          <div v-if="session.snippet" class="snippet">{{ session.snippet }}</div>
          <div class="item-tags">
            <NTag v-if="session.running" size="tiny" type="info" :bordered="false">{{ t('agentHistory.status.running') }}</NTag>
            <NTag v-if="session.scene" size="tiny" :bordered="false">{{ session.scene.label ?? tagLabel(`scene:${session.scene.key}`) }}</NTag>
            <NTag v-for="tag in rowTags(session)" :key="tag" size="tiny" type="success" :bordered="false">{{ tagLabel(tag) }}</NTag>
          </div>
        </button>
      </NSpin>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.filters {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.empty {
  margin: 32px 0;
}

.item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 10px 12px;
  margin-bottom: 6px;
  border: 1px solid rgba(127, 127, 127, 0.2);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.item:hover,
.item.current {
  border-color: #7c8bd9;
}

.item-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.title {
  flex: 1;
  min-width: 0;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time {
  font-size: 12px;
  opacity: 0.55;
  flex: none;
}

.snippet {
  font-size: 12px;
  opacity: 0.7;
  line-height: 1.5;
}

.item-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
