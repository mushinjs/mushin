<script setup lang="ts">
import { GitNetworkOutline, SettingsOutline } from '@vicons/ionicons5'
import IconAction from './IconAction.vue'
import { NButton, NCard, NEmpty, NIcon, NList, NListItem, NModal, NSpace, NSpin, NSwitch, NTag, NThing, useMessage } from 'naive-ui'
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
const message = useMessage()

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
  <NCard>
    <NSpin :show="loading">
      <NList v-if="plugins.length" hoverable>
        <NListItem v-for="plugin in plugins" :key="plugin.package">
          <NThing>
            <template #header>
              <NSpace align="center" :size="8">
                <span>{{ localize(plugin.manifest.displayName, locale) || plugin.package }}</span>
                <StatusBadge v-if="plugin.enabled" :status="plugin.status" :error="plugin.error" />
                <NTag v-for="platform in plugin.manifest.platforms ?? []" :key="platform" size="tiny" :bordered="false">{{ platform }}</NTag>
              </NSpace>
            </template>
            <template #description>
              <span class="mono sub">{{ plugin.package }}@{{ plugin.version }}</span>
            </template>
            {{ localize(plugin.manifest.description, locale) }}
            <DependencyTags v-if="plugin.dependencies?.requires.some((dep) => dep.problem && dep.problem !== 'not-app')" :deps="{ requires: plugin.dependencies.requires, optional: [] }" :catalog="catalog" />
            <div v-if="flowsBy[plugin.package]?.length" class="flows">
              <span class="sub">{{ t('botPlugins.madeFlows') }}</span>
              <RouterLink v-for="flow in flowsBy[plugin.package]" :key="flow.id" :to="`/flows/${flow.id}`">
                <NTag size="small" :bordered="false" type="info" class="clickable">
                  <template #icon><NIcon><GitNetworkOutline /></NIcon></template>
                  {{ flow.name }}
                </NTag>
              </RouterLink>
              <span v-if="plugin.package === '@mushin/bot-plugin-llm-chat'" class="sub">{{ t('botPlugins.llmChatHint') }}</span>
            </div>
          </NThing>
          <template #suffix>
            <NSpace :wrap="false" align="center">
              <IconAction v-if="hasSettings(plugin)" :icon="SettingsOutline" :label="t('common.configure')" @click="configure(plugin)" />
              <NSwitch :value="plugin.enabled" :loading="busy === plugin.package" @update:value="(value: boolean) => toggle(plugin, value)" />
            </NSpace>
          </template>
        </NListItem>
      </NList>
      <NEmpty v-else-if="!loading" :description="t('plugins.noBotPlugins')" />
    </NSpin>

    <NModal
      :show="!!editing"
      preset="card"
      :title="editing ? localize(editing.manifest.displayName, locale) || editing.package : ''"
      style="width: min(560px, calc(100vw - 32px))"
      @update:show="(value: boolean) => !value && (editing = undefined)"
    >
      <SchemaForm v-if="editing?.configSchema" v-model="draft" :schema="editing.configSchema" />
      <template #footer>
        <NSpace justify="end">
          <NButton @click="editing = undefined">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" @click="save">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </NCard>
</template>

<style scoped>
.sub {
  opacity: 0.55;
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
