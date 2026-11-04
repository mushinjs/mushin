<script setup lang="ts">
import IconAction from './IconAction.vue'
import { Button, Card, Empty, Modal, Spin, Tag, Toggle, useToast } from '@mushin/ui'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { call, on } from '../api'
import type { BotPluginInfo, CatalogEntry, FlowSummary } from '../types'
import { clone, localize } from '../utils'
import DependencyTags from './DependencyTags.vue'
import SchemaForm from './SchemaForm.vue'
import StatusBadge from './StatusBadge.vue'

const props = defineProps<{ botId: string }>()
const { t, locale } = useI18n()
const message = useToast()

const plugins = ref<BotPluginInfo[]>([])
/** Flows each plugin made on this bot, such as LLM chat's flow, by package. */
const flowsBy = ref<Record<string, FlowSummary[]>>({})
const catalog = ref<CatalogEntry[]>([])
const loading = ref(true)
const busy = ref<string>()
const editing = ref<BotPluginInfo>()
const draft = ref<Record<string, any>>({})
const saving = ref(false)

async function refresh() {
  try {
    plugins.value = await call<BotPluginInfo[]>('bots.plugins.list', { id: props.botId })
    const flows = await call<FlowSummary[]>('flows.list').catch(() => [] as FlowSummary[])
    const owned: Record<string, FlowSummary[]> = {}
    for (const flow of flows) {
      if (flow.source?.kind === 'plugin' && flow.source.plugin && flow.bots.includes(props.botId)) (owned[flow.source.plugin] ??= []).push(flow)
    }
    flowsBy.value = owned
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  refresh()
  call<CatalogEntry[]>('plugins.catalog').then((list) => (catalog.value = list), () => {})
})
watch(() => props.botId, refresh)
const offs = [on('bots/changed', refresh), on('flows/changed', refresh)]
onBeforeUnmount(() => offs.forEach((off) => off()))

/** A config form only for plugins that still have settings; LLM chat keeps its settings in its flow. */
const hasSettings = (plugin: BotPluginInfo) => !!plugin.configSchema && Object.keys(plugin.configSchema.properties ?? {}).length > 0

async function toggle(plugin: BotPluginInfo, enabled: boolean) {
  busy.value = plugin.package
  try {
    await call(enabled ? 'bots.plugins.enable' : 'bots.plugins.disable', { id: props.botId, package: plugin.package })
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    busy.value = undefined
  }
}

function configure(plugin: BotPluginInfo) {
  editing.value = plugin
  draft.value = clone(plugin.config)
}

async function save() {
  if (!editing.value) return
  saving.value = true
  try {
    await call('bots.plugins.configure', { id: props.botId, package: editing.value.package, config: draft.value })
    editing.value = undefined
    message.success(t('common.saved'))
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Card>
    <Spin :show="loading">
      <ul v-if="plugins.length" class="list">
        <li v-for="plugin in plugins" :key="plugin.package" class="item">
          <div class="main">
            <div class="head">
              <span class="name">{{ localize(plugin.manifest.displayName, locale) || plugin.package }}</span>
              <StatusBadge v-if="plugin.enabled" :status="plugin.status" :error="plugin.error" />
              <Tag v-for="platform in plugin.manifest.platforms ?? []" :key="platform" size="tiny">{{ platform }}</Tag>
            </div>
            <div class="mono sub">{{ plugin.package }}@{{ plugin.version }}</div>
            <div class="desc">{{ localize(plugin.manifest.description, locale) }}</div>
            <DependencyTags v-if="plugin.dependencies?.requires.some((dep) => dep.problem && dep.problem !== 'not-app')" :deps="{ requires: plugin.dependencies.requires, optional: [] }" :catalog="catalog" />
            <div v-if="flowsBy[plugin.package]?.length" class="flows">
              <span class="sub">{{ t('botPlugins.madeFlows') }}</span>
              <RouterLink v-for="flow in flowsBy[plugin.package]" :key="flow.id" :to="`/flows/${flow.id}`">
                <Tag size="small" type="info" icon="i-lucide-network" class="clickable">{{ flow.name }}</Tag>
              </RouterLink>
              <span v-if="plugin.package === '@mushin/bot-plugin-llm-chat'" class="sub">{{ t('botPlugins.llmChatHint') }}</span>
            </div>
          </div>
          <div class="actions">
            <IconAction v-if="hasSettings(plugin)" icon="i-lucide-settings" :label="t('common.configure')" @click="configure(plugin)" />
            <Toggle variant="button" :value="plugin.enabled" :loading="busy === plugin.package" @update:value="(value: boolean) => toggle(plugin, value)" />
          </div>
        </li>
      </ul>
      <Empty v-else-if="!loading" :description="t('plugins.noBotPlugins')" />
    </Spin>

    <Modal
      :show="!!editing"
      :title="editing ? localize(editing.manifest.displayName, locale) || editing.package : ''"
      :width="560"
      @update:show="(value: boolean) => !value && (editing = undefined)"
    >
      <SchemaForm v-if="editing?.configSchema" v-model="draft" :schema="editing.configSchema" />
      <template #footer>
        <Button @click="editing = undefined">{{ t('common.cancel') }}</Button>
        <Button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</Button>
      </template>
    </Modal>
  </Card>
</template>

<style scoped>
.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 4px;
}

.item + .item {
  border-top: 1px solid var(--line);
}

.main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.name {
  font-weight: 600;
}

.desc {
  margin-top: 2px;
  font-size: 13.5px;
  color: var(--fg2);
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}

.sub {
  font-size: 12px;
  color: var(--fg3);
}

.flows {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
}

.clickable {
  cursor: pointer;
}
</style>
