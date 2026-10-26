<script setup lang="ts">
import { AddOutline, CreateOutline, RefreshOutline, TrashOutline } from '@vicons/ionicons5'
import {
  NAlert, NButton, NCard, NDynamicInput, NDynamicTags, NEmpty, NForm, NFormItem, NIcon, NInput, NModal, NRadioButton, NRadioGroup, NSelect,
  NSpace, NSpin, NSwitch, NTag, useDialog, useMessage,
} from 'naive-ui'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { call, on } from '../../api'
import IconAction from '../IconAction.vue'

interface McpTool {
  name: string
  title?: string
  description?: string
  action: string
  risk: 'read' | 'write' | 'dangerous'
  enabled: boolean
}

interface McpServer {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  enabled: boolean
  status: 'stopped' | 'connecting' | 'connected' | 'error'
  error?: string
  serverInfo?: { name?: string; version?: string }
  stderr: string[]
  tools: McpTool[]
}

interface Form {
  id?: string
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  env: { key: string; value: string }[]
  cwd: string
  url: string
  headers: { key: string; value: string }[]
}

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

const servers = ref<McpServer[]>([])
const available = ref<boolean>()
const loading = ref(false)
const form = ref<Form>()
const saving = ref(false)
const busy = ref<string>()

async function refresh() {
  loading.value = true
  try {
    servers.value = await call<McpServer[]>('mcp.servers.list')
    available.value = true
  } catch (error: any) {
    if (error?.code === 'not_found') available.value = false
    else message.error(error.message)
  } finally {
    loading.value = false
  }
}

let off: (() => void) | undefined
onMounted(() => {
  refresh()
  off = on('mcp/changed', () => refresh())
})
onBeforeUnmount(() => off?.())

const pairs = (values?: Record<string, string>) => Object.entries(values ?? {}).map(([key, value]) => ({ key, value }))
const record = (list: { key: string; value: string }[]) => Object.fromEntries(list.filter((item) => item.key.trim()).map((item) => [item.key.trim(), item.value]))

function openNew() {
  form.value = { name: '', transport: 'stdio', command: 'npx', args: [], env: [], cwd: '', url: '', headers: [] }
}

function openEdit(server: McpServer) {
  form.value = {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    args: [...server.args ?? []],
    env: pairs(server.env),
    cwd: server.cwd ?? '',
    url: server.url ?? '',
    headers: pairs(server.headers),
  }
}

async function save() {
  const value = form.value!
  saving.value = true
  const body = {
    name: value.name,
    transport: value.transport,
    ...(value.transport === 'stdio'
      ? { command: value.command, args: value.args, env: record(value.env), ...(value.cwd ? { cwd: value.cwd } : {}) }
      : { url: value.url, headers: record(value.headers) }),
  }
  try {
    const result = value.id
      ? await call<McpServer>('mcp.servers.update', { id: value.id, ...body })
      : await call<McpServer>('mcp.servers.create', body)
    form.value = undefined
    if (result.status === 'error') message.warning(t('agentPage.mcp.savedError', { error: result.error }))
    else message.success(t('agentPage.mcp.connected', { count: result.tools.length }))
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

async function run(id: string, task: () => Promise<unknown>) {
  busy.value = id
  try {
    await task()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    busy.value = undefined
    await refresh()
  }
}

function remove(server: McpServer) {
  dialog.warning({
    title: t('common.confirmDelete', { name: server.name }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => run(server.id, () => call('mcp.servers.delete', { id: server.id })),
  })
}

const riskOptions = ['read', 'write', 'dangerous'].map((risk) => ({ label: t(`agentPage.tools.risk.${risk}`), value: risk }))
const statusType = { connected: 'success', connecting: 'info', error: 'error', stopped: 'default' } as const
</script>

<template>
  <div class="mcp">
    <NAlert v-if="available === false" type="warning" :title="t('agentPage.mcp.unavailable')">
      {{ t('agentPage.mcp.unavailableHint') }}
      <RouterLink to="/plugins?highlight=@mushin/plugin-mcp">{{ t('permissions.openPlugins') }}</RouterLink>
    </NAlert>
    <template v-else>
      <div class="toolbar">
        <p class="hint">{{ t('agentPage.mcp.lead') }}</p>
        <NButton type="primary" @click="openNew">
          <template #icon><NIcon><AddOutline /></NIcon></template>
          {{ t('agentPage.mcp.add') }}
        </NButton>
      </div>
      <NSpin :show="loading && !servers.length">
        <NEmpty v-if="!servers.length && !loading" :description="t('agentPage.mcp.empty')" />
        <div class="list">
          <NCard v-for="server in servers" :key="server.id" size="small">
            <div class="server-head">
              <div class="server-name">
                <span>{{ server.name }}</span>
                <NTag size="tiny" :bordered="false">{{ server.transport === 'stdio' ? 'stdio' : 'HTTP' }}</NTag>
                <NTag size="tiny" :type="statusType[server.status]" :bordered="false">{{ t(`agentPage.mcp.status.${server.status}`) }}</NTag>
                <span v-if="server.serverInfo?.name" class="hint small">{{ server.serverInfo.name }} {{ server.serverInfo.version }}</span>
              </div>
              <div class="server-actions">
                <NSwitch
                  size="small"
                  :value="server.enabled"
                  :loading="busy === server.id"
                  @update:value="(enabled: boolean) => run(server.id, () => call('mcp.servers.update', { id: server.id, enabled }))"
                />
                <IconAction :icon="RefreshOutline" :label="t('agentPage.mcp.restart')" :disabled="!server.enabled" :loading="busy === server.id" @click="run(server.id, () => call('mcp.servers.restart', { id: server.id }))" />
                <IconAction :icon="CreateOutline" :label="t('common.edit')" @click="openEdit(server)" />
                <IconAction :icon="TrashOutline" type="error" :label="t('common.delete')" @click="remove(server)" />
              </div>
            </div>
            <div class="mono hint small endpoint">{{ server.transport === 'stdio' ? [server.command, ...server.args ?? []].join(' ') : server.url }}</div>
            <NAlert v-if="server.error" type="error" :show-icon="false" class="error">
              {{ server.error }}
              <pre v-if="server.stderr.length" class="mono stderr">{{ server.stderr.slice(-6).join('\n') }}</pre>
            </NAlert>
            <div v-if="server.tools.length" class="tools">
              <div v-for="tool in server.tools" :key="tool.name" class="tool" :class="{ off: !tool.enabled }">
                <NSwitch size="small" :value="tool.enabled" @update:value="(enabled: boolean) => run(server.id, () => call('mcp.tools.update', { id: server.id, tool: tool.name, enabled }))" />
                <div class="tool-main">
                  <div class="tool-name"><span class="mono">{{ tool.name }}</span><span class="hint small mono">{{ tool.action }}</span></div>
                  <div v-if="tool.description" class="hint small tool-desc">{{ tool.description }}</div>
                </div>
                <NSelect
                  size="small"
                  class="tool-risk"
                  :value="tool.risk"
                  :options="riskOptions"
                  @update:value="(risk: string) => run(server.id, () => call('mcp.tools.update', { id: server.id, tool: tool.name, risk }))"
                />
              </div>
            </div>
          </NCard>
        </div>
      </NSpin>
    </template>

    <NModal :show="!!form" preset="card" :title="form?.id ? t('agentPage.mcp.edit') : t('agentPage.mcp.add')" :style="{ width: '600px', maxWidth: '95vw' }" @update:show="(show: boolean) => !show && (form = undefined)">
      <NForm v-if="form" label-placement="top">
        <NFormItem :label="t('common.name')" required>
          <NInput v-model:value="form.name" placeholder="filesystem" />
        </NFormItem>
        <NFormItem :label="t('agentPage.mcp.transport')">
          <NRadioGroup v-model:value="form.transport">
            <NRadioButton value="stdio">{{ t('agentPage.mcp.stdio') }}</NRadioButton>
            <NRadioButton value="http">{{ t('agentPage.mcp.http') }}</NRadioButton>
          </NRadioGroup>
        </NFormItem>
        <template v-if="form.transport === 'stdio'">
          <NFormItem :label="t('agentPage.mcp.command')" required>
            <NInput v-model:value="form.command" class="mono" placeholder="npx" />
          </NFormItem>
          <NFormItem :label="t('agentPage.mcp.args')" :feedback="t('agentPage.mcp.argsHelp')">
            <NDynamicTags v-model:value="form.args" />
          </NFormItem>
          <NFormItem :label="t('agentPage.mcp.env')" :feedback="t('agentPage.mcp.secretHelp')">
            <NDynamicInput v-model:value="form.env" preset="pair" key-placeholder="API_KEY" :value-placeholder="t('agentPage.mcp.value')" />
          </NFormItem>
          <NFormItem :label="t('agentPage.mcp.cwd')">
            <NInput v-model:value="form.cwd" class="mono" />
          </NFormItem>
        </template>
        <template v-else>
          <NFormItem :label="t('agentPage.mcp.url')" required>
            <NInput v-model:value="form.url" class="mono" placeholder="https://example.com/mcp" />
          </NFormItem>
          <NFormItem :label="t('agentPage.mcp.headers')" :feedback="t('agentPage.mcp.secretHelp')">
            <NDynamicInput v-model:value="form.headers" preset="pair" key-placeholder="Authorization" :value-placeholder="t('agentPage.mcp.value')" />
          </NFormItem>
        </template>
        <p class="hint small">{{ t('agentPage.mcp.newTools') }}</p>
      </NForm>
      <template #action>
        <NSpace justify="end">
          <NButton @click="form = undefined">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" @click="save">{{ t('agentPage.mcp.saveConnect') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.toolbar p {
  margin: 0;
}

.hint {
  opacity: 0.65;
}

.small {
  font-size: 12px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.server-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.server-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  flex-wrap: wrap;
}

.server-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.endpoint {
  margin: 4px 0 8px;
  word-break: break-all;
}

.error {
  margin-bottom: 8px;
}

.stderr {
  margin: 6px 0 0;
  font-size: 12px;
  white-space: pre-wrap;
}

.tools {
  display: flex;
  flex-direction: column;
  border-top: 1px solid rgba(127, 127, 127, 0.15);
}

.tool {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid rgba(127, 127, 127, 0.1);
}

.tool.off .tool-main {
  opacity: 0.5;
}

.tool-main {
  flex: 1;
  min-width: 0;
}

.tool-name {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}

.tool-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-risk {
  width: 120px;
  flex: none;
}
</style>
