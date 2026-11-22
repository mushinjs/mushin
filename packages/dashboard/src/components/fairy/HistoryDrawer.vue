<script setup lang="ts">
import { Drawer, Empty, Input, Select, Spin, Tag } from '@mushinjs/ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../../api'
import { useFairyStore } from '../../stores/fairy'
import type { FairySessionSummary } from '../../types'
import { formatTime } from '../../utils'

const show = defineModel<boolean>('show', { required: true })

const { t, te } = useI18n()
const fairy = useFairyStore()
const query = ref('')
const tags = ref<string[]>([])
const results = ref<FairySessionSummary[]>([])
const loading = ref(false)

const SCENES = ['overview', 'setup', 'providers', 'bots', 'botDetail', 'flows', 'flowEditor', 'personas', 'plugins', 'logs', 'settings', 'fairy']

/** A tag as the user reads it, e.g. `场景：流程编辑器`. */
function tagLabel(tag: string) {
  const [kind, ...rest] = tag.split(':')
  const value = rest.join(':')
  if (kind === 'scene') return `${t('fairyHistory.tag.scene')}：${te(`fairyScene.name.${value}`) ? t(`fairyScene.name.${value}`) : value}`
  if (kind === 'skill') return `${t('fairyHistory.tag.skill')}：${fairy.skills.find((skill) => skill.id === value)?.name ?? value}`
  if (kind === 'command') return `${t('fairyHistory.tag.command')}：/${value}`
  if (kind === 'status') return `${t('fairyHistory.tag.status')}：${t(`fairyHistory.status.${value}`)}`
  if (kind === 'resource') return `${t('fairyHistory.tag.resource')}：${value.split(':')[0]}`
  return tag
}

const tagOptions = computed(() => {
  const seen = new Set<string>([
    ...SCENES.map((scene) => `scene:${scene}`),
    ...fairy.skills.map((skill) => `skill:${skill.id}`),
    'status:running',
    ...fairy.sessions.flatMap((session) => session.tags.filter((tag) => tag.startsWith('command:'))),
  ])
  return [...seen].map((tag) => ({ label: tagLabel(tag), value: tag }))
})

let seq = 0
async function search() {
  const mine = ++seq
  loading.value = true
  try {
    const list = await call<FairySessionSummary[]>('fairy.search', { query: query.value.trim() || undefined, tags: tags.value.length ? tags.value : undefined })
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
  await fairy.load(id)
  show.value = false
}

/** Tags worth showing on a row: where it started and the skills and commands it used. */
function rowTags(session: FairySessionSummary) {
  return session.tags.filter((tag) => tag.startsWith('skill:') || tag.startsWith('command:')).slice(0, 4)
}
</script>

<template>
  <Drawer v-model:show="show" :width="440" placement="right" :title="t('fairyHistory.title')" closable>
    <div class="content">
      <div class="filters">
        <Input v-model:value="query" clearable :placeholder="t('fairyHistory.search')">
          <template #prefix><span class="i-lucide-search" /></template>
        </Input>
        <Select v-model:value="tags" multiple filterable clearable :options="tagOptions" :placeholder="t('fairyHistory.tags')" max-tag-count="responsive" />
      </div>
      <Spin :show="loading" size="small">
        <Empty v-if="!results.length && !loading" :description="t('fairyHistory.empty')" class="empty" />
        <button
          v-for="session in results"
          :key="session.id"
          type="button"
          class="item"
          :class="{ current: session.id === fairy.current }"
          @click="openSession(session.id)"
        >
          <div class="item-head">
            <span class="title">{{ session.title || t('fairy.untitled') }}</span>
            <span class="time">{{ formatTime(session.updatedAt) }}</span>
          </div>
          <div v-if="session.snippet" class="snippet">{{ session.snippet }}</div>
          <div class="item-tags">
            <Tag v-if="session.running" size="tiny" type="info">{{ t('fairyHistory.status.running') }}</Tag>
            <Tag v-if="session.scene" size="tiny">{{ session.scene.label ?? tagLabel(`scene:${session.scene.key}`) }}</Tag>
            <Tag v-for="tag in rowTags(session)" :key="tag" size="tiny" type="success">{{ tagLabel(tag) }}</Tag>
          </div>
        </button>
      </Spin>
    </div>
  </Drawer>
</template>

<style scoped>
.content {
  padding: 16px 20px 20px;
}

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
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.item:hover,
.item.current {
  border-color: var(--primary);
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
  color: var(--fg3);
  flex: none;
}

.snippet {
  font-size: 12px;
  color: var(--fg2);
  line-height: 1.5;
}

.item-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
