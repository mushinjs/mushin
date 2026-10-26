<script setup lang="ts">
import { RefreshOutline, SettingsOutline } from '@vicons/ionicons5'
import IconAction from '../components/IconAction.vue'
import { NButton, NCard, NInput, NList, NListItem, NModal, NSpace, NSpin, NSwitch, NTag, NThing, NTooltip, useMessage } from 'naive-ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { call, on } from '../api'
import SchemaForm from '../components/SchemaForm.vue'
import StatusBadge from '../components/StatusBadge.vue'
import type { AppPlugin, CatalogEntry } from '../types'
import { clone, localize } from '../utils'

const { t, locale } = useI18n()
const message = useMessage()
const route = useRoute()


const plugins = ref<AppPlugin[]>([])
const appCatalog = ref<CatalogEntry[]>([])
const botPlugins = ref<CatalogEntry[]>([])
const loading = ref(true)
const busy = ref<string>()
const editing = ref<AppPlugin>()
const draft = ref<Record<string, any>>({})
const jsonDraft = ref('')
const saving = ref(false)

/** /plugins?highlight=<package> scrolls to that plugin and makes it stand out for a moment. */
const highlighted = ref<string>()
watch(() => [route.query.highlight, plugins.value.length] as const, async ([target]) => {
  if (typeof target !== 'string' || !plugins.value.length) return
  highlighted.value = target
  await nextTick()
  document.getElementById(`plugin-${target}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  window.setTimeout(() => (highlighted.value = undefined), 2500)
})

async function refresh(rescan = false) {
  try {
    const [list, catalog] = await Promise.all([
      call<AppPlugin[]>('plugins.list'),
      call<CatalogEntry[]>('plugins.catalog', { refresh: rescan }),
    ])
    plugins.value = list
    appCatalog.value = catalog.filter((entry) => entry.manifest.kind === 'app')
    botPlugins.value = catalog.filter((entry) => entry.manifest.kind === 'bot')
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(() => refresh())

/** Configured entries, then installed app plugins that were never enabled (they have no entry id yet). */
const appPlugins = computed<AppPlugin[]>(() => [
  ...plugins.value,
  ...appCatalog.value
    .filter((entry) => !plugins.value.some((plugin) => plugin.package === entry.package))
    .map((entry) => ({ id: '', package: entry.package, enabled: false, config: {}, manifest: entry.manifest, version: entry.version, status: 'disabled' as const })),
])

const keyOf = (plugin: AppPlugin) => plugin.id || plugin.package

async function rescan() {
  loading.value = true
  await refresh(true)
  message.success(t('plugins.rescanned'))
}
let timer: number | undefined
const off = on('manager/changed', () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => refresh(), 150)
})
onBeforeUnmount(off)

async function toggle(plugin: AppPlugin, enabled: boolean) {
  busy.value = keyOf(plugin)
  try {
    if (enabled) await call('plugins.enable', { package: plugin.package, id: plugin.id || undefined })
    else await call('plugins.disable', { id: plugin.id })
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    busy.value = undefined
  }
}

async function reload(plugin: AppPlugin) {
  busy.value = plugin.id
  try {
    await call('plugins.reload', { id: plugin.id })
    message.success(t('plugins.reloaded'))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    busy.value = undefined
  }
}

function configure(plugin: AppPlugin) {
  editing.value = plugin
  draft.value = clone(plugin.config)
  jsonDraft.value = JSON.stringify(plugin.config, null, 2)
}

async function save() {
  if (!editing.value) return
  saving.value = true
  try {
    const config = editing.value.configSchema ? draft.value : JSON.parse(jsonDraft.value || '{}')
    await call('plugins.configure', { id: editing.value.id, config })
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
  <div class="page">
    <div class="page-header">
      <div>
        <h1>{{ t('nav.plugins') }}</h1>
        <p class="page-lead">{{ t('plugins.lead') }}</p>
      </div>
      <NButton :loading="loading" @click="rescan">{{ t('plugins.rescan') }}</NButton>
    </div>

    <NSpin :show="loading">
      <NCard :title="t('plugins.appPlugins')" class="section">
        <NList hoverable>
          <NListItem v-for="plugin in appPlugins" :id="`plugin-${plugin.package}`" :key="keyOf(plugin)" :class="{ highlighted: highlighted === plugin.package }">
            <NThing>
              <template #header>
                <NSpace align="center" :size="8">
                  <span>{{ localize(plugin.manifest?.displayName, locale) || plugin.package }}</span>
                  <StatusBadge :status="plugin.status" :error="plugin.error" />
                  <NTooltip v-if="plugin.manifest?.essential">
                    <template #trigger><NTag size="tiny" :bordered="false">{{ t('plugins.essential') }}</NTag></template>
                    {{ t('plugins.essentialHint') }}
                  </NTooltip>
                </NSpace>
              </template>
              <template #description>
                <span class="mono sub">{{ plugin.package }}{{ plugin.version ? `@${plugin.version}` : '' }}</span>
              </template>
              {{ localize(plugin.manifest?.description, locale) }}
            </NThing>
            <template #suffix>
              <NSpace :wrap="false" align="center">
                <IconAction :icon="RefreshOutline" :label="t('common.reload')" :disabled="!plugin.enabled" @click="reload(plugin)" />
                <IconAction :icon="SettingsOutline" :label="t('common.configure')" :disabled="!plugin.id" @click="configure(plugin)" />
                <NSwitch
                  :value="plugin.enabled"
                  :disabled="plugin.manifest?.essential && plugin.enabled"
                  :loading="busy === keyOf(plugin)"
                  @update:value="(value: boolean) => toggle(plugin, value)"
                />
              </NSpace>
            </template>
          </NListItem>
        </NList>
      </NCard>

      <NCard :title="t('plugins.botPlugins')" class="section">
        <p class="sub">{{ t('plugins.botPluginsHint') }}</p>
        <NList>
          <NListItem v-for="entry in botPlugins" :key="entry.package">
            <NThing :title="localize(entry.manifest.displayName, locale) || entry.package">
              <template #description>
                <span class="mono sub">{{ entry.package }}@{{ entry.version }}</span>
              </template>
              {{ localize(entry.manifest.description, locale) }}
            </NThing>
            <template #suffix>
              <NSpace :wrap="false">
                <NTag v-for="platform in entry.manifest.platforms ?? []" :key="platform" size="small" :bordered="false">{{ platform }}</NTag>
                <NTag v-if="entry.local" size="small" type="warning" :bordered="false">{{ t('plugins.local') }}</NTag>
              </NSpace>
            </template>
          </NListItem>
        </NList>
      </NCard>
    </NSpin>

    <NModal
      :show="!!editing"
      preset="card"
      :title="editing ? localize(editing.manifest?.displayName, locale) || editing.package : ''"
      style="width: min(560px, calc(100vw - 32px))"
      @update:show="(value: boolean) => !value && (editing = undefined)"
    >
      <SchemaForm v-if="editing?.configSchema" v-model="draft" :schema="editing.configSchema" />
      <template v-else-if="editing">
        <p class="sub">{{ t('plugins.rawConfig') }}</p>
        <NInput v-model:value="jsonDraft" type="textarea" class="mono" :autosize="{ minRows: 6, maxRows: 20 }" />
      </template>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="editing = undefined">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" @click="save">{{ t('common.saveAndReload') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.highlighted {
  background: rgba(32, 128, 240, 0.12) !important;
  transition: background-color 0.4s;
}

.section {
  margin-bottom: 16px;
}

.sub {
  font-size: 12px;
  opacity: 0.6;
}

p.sub {
  margin: 0 0 8px;
}
</style>
