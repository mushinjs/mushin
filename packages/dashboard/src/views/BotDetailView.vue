<script setup lang="ts">
import { ArrowBackOutline } from '@vicons/ionicons5'
import { NButton, NIcon, NSpace, NTabPane, NTabs, useDialog, useMessage } from 'naive-ui'
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { call } from '../api'
import BotCommands from '../components/BotCommands.vue'
import BotConnection from '../components/BotConnection.vue'
import BotFlowOverview from '../components/BotFlowOverview.vue'
import BotLogs from '../components/BotLogs.vue'
import BotPermissions from '../components/BotPermissions.vue'
import BotPlugins from '../components/BotPlugins.vue'
import LiveConversation from '../components/LiveConversation.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useDataStore } from '../stores/data'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const data = useDataStore()
const message = useMessage()
const dialog = useDialog()

const id = computed(() => String(route.params.id))
const tab = computed(() => String(route.params.tab))
const bot = computed(() => data.bots.find((item) => item.id === id.value))

onMounted(() => {
  if (!data.loadedBots) data.refreshBots().catch(() => {})
})

async function run(action: string) {
  try {
    await call(action, { id: id.value })
    await data.refreshBots()
  } catch (error) {
    message.error((error as Error).message)
  }
}

function remove() {
  dialog.warning({
    title: t('common.confirmDelete', { name: bot.value?.name }),
    content: t('bots.deleteHint'),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await call('bots.delete', { id: id.value })
      message.success(t('common.deleted'))
      await data.refreshBots()
      router.push('/bots')
    },
  })
}
</script>

<template>
  <div class="page">
    <div v-if="bot" class="page-header">
      <div class="title">
        <NButton quaternary circle :aria-label="t('common.back')" @click="router.push('/bots')">
          <template #icon><NIcon><ArrowBackOutline /></NIcon></template>
        </NButton>
        <div>
          <h1>{{ bot.name }} <StatusBadge :status="bot.status" :error="bot.error" /></h1>
          <p class="page-lead">
            {{ bot.selfName ? `${bot.selfName} · ${bot.selfId}` : bot.selfId ?? t('bots.notLoggedIn') }}
            <template v-if="bot.status === 'error' && bot.error">
              · <span class="error">{{ bot.error }}</span>
              · <RouterLink :to="`/bots/${id}/logs`">{{ t('bot.viewLogs') }}</RouterLink>
            </template>
          </p>
        </div>
      </div>
      <NSpace>
        <NButton v-if="bot.enabled" @click="run('bots.start')">{{ t('bots.restart') }}</NButton>
        <NButton v-if="bot.enabled" @click="run('bots.stop')">{{ t('common.stop') }}</NButton>
        <NButton v-else type="primary" @click="run('bots.start')">{{ t('common.start') }}</NButton>
        <NButton type="error" secondary @click="remove">{{ t('common.delete') }}</NButton>
      </NSpace>
    </div>

    <NTabs v-if="bot" :value="tab" type="line" animated @update:value="(next: string) => router.replace(`/bots/${id}/${next}`)">
      <NTabPane name="connection" :tab="t('bot.connection')" data-agent-target="bot.connection">
        <BotConnection :bot="bot" />
      </NTabPane>
      <NTabPane name="plugins" :tab="t('bot.plugins')" data-agent-target="bot.plugins">
        <BotPlugins :bot-id="bot.id" />
      </NTabPane>
      <NTabPane name="overview" :tab="t('bot.flowOverview')" data-agent-target="bot.overview">
        <BotFlowOverview :bot="bot" />
      </NTabPane>
      <NTabPane name="commands" :tab="t('bot.commands')" data-agent-target="bot.commands">
        <BotCommands :bot="bot" />
      </NTabPane>
      <NTabPane name="permissions" :tab="t('bot.permissions')" data-agent-target="bot.permissions">
        <BotPermissions :bot="bot" />
      </NTabPane>
      <NTabPane name="live" :tab="t('bot.live')" data-agent-target="bot.live">
        <LiveConversation :bot-id="bot.id" />
      </NTabPane>
      <NTabPane name="logs" :tab="t('bot.logs')" data-agent-target="bot.logs">
        <BotLogs :bot-id="bot.id" />
      </NTabPane>
    </NTabs>

    <p v-else-if="data.loadedBots">{{ t('bots.notFound') }}</p>
  </div>
</template>

<style scoped>
.title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title h1 {
  display: flex;
  align-items: center;
  gap: 10px;
}

.error {
  color: #d03050;
}
</style>
