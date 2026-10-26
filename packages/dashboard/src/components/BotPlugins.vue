<script setup lang="ts">
import { SettingsOutline } from '@vicons/ionicons5'
import IconAction from './IconAction.vue'
import { NButton, NCard, NEmpty, NList, NListItem, NModal, NSpace, NSpin, NSwitch, NTag, NThing, useMessage } from 'naive-ui'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call, on } from '../api'
import type { BotPluginInfo, CatalogEntry } from '../types'
import { clone, localize } from '../utils'
import DependencyTags from './DependencyTags.vue'
import SchemaForm from './SchemaForm.vue'
import StatusBadge from './StatusBadge.vue'

const props = defineProps<{ botId: string }>()
const { t, locale } = useI18n()
const message = useMessage()

const plugins = ref<BotPluginInfo[]>([])
const catalog = ref<CatalogEntry[]>([])
const loading = ref(true)
const busy = ref<string>()
const editing = ref<BotPluginInfo>()
const draft = ref<Record<string, any>>({})
const saving = ref(false)

async function refresh() {
  try {
    plugins.value = await call<BotPluginInfo[]>('bots.plugins.list', { id: props.botId })
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
const off = on('bots/changed', refresh)
onBeforeUnmount(off)

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
          </NThing>
          <template #suffix>
            <NSpace :wrap="false" align="center">
              <IconAction v-if="plugin.configSchema" :icon="SettingsOutline" :label="t('common.configure')" @click="configure(plugin)" />
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
</style>
