<script setup lang="ts">
import { AddOutline, ChatbubblesOutline } from '@vicons/ionicons5'
import { NButton, NCard, NEmpty, NGrid, NGridItem, NIcon, NSpace, NSwitch, NTag, useMessage } from 'naive-ui'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call } from '../api'
import BotEditor from '../components/BotEditor.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useDataStore } from '../stores/data'
import type { Bot } from '../types'

const { t } = useI18n()
const router = useRouter()
const data = useDataStore()
const message = useMessage()
const showCreate = ref(false)
const busy = ref<string>()

onMounted(() => data.refreshBots().catch((error) => message.error(error.message)))

async function toggle(bot: Bot, enabled: boolean) {
  busy.value = bot.id
  try {
    await call(enabled ? 'bots.start' : 'bots.stop', { id: bot.id })
    await data.refreshBots()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    busy.value = undefined
  }
}

/** The connection mode as a short tag, and where the bot connects. */
function connectionOf(bot: Bot) {
  const info = bot.connection
  if (!info) return { tag: bot.adapter.type, address: '' }
  const tag = t(`bots.mode.${info.mode}`) === `bots.mode.${info.mode}` ? info.mode : t(`bots.mode.${info.mode}`)
  if (info.mode === 'ws-reverse') return { tag, address: t('bots.reverseTo', { path: info.address }) }
  if (info.mode === 'http') return { tag, address: t('bots.httpTo', { url: info.address, path: info.inbound }) }
  return { tag, address: t('bots.forwardTo', { url: info.address }) }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>{{ t('nav.bots') }}</h1>
        <p class="page-lead">{{ t('bots.lead') }}</p>
      </div>
      <NButton type="primary" data-agent-target="bots.add" @click="showCreate = true">
        <template #icon><NIcon><AddOutline /></NIcon></template>
        {{ t('bots.add') }}
      </NButton>
    </div>

    <NGrid v-if="data.bots.length" cols="1 640:2 1000:3" :x-gap="16" :y-gap="16">
      <NGridItem v-for="bot in data.bots" :key="bot.id">
        <NCard hoverable class="bot-card" @click="router.push(`/bots/${bot.id}`)">
          <div class="bot-head">
            <div class="bot-avatar"><NIcon size="22"><ChatbubblesOutline /></NIcon></div>
            <div class="bot-title">
              <strong>{{ bot.name }}</strong>
              <span class="sub">{{ bot.selfName ? `${bot.selfName} (${bot.selfId})` : bot.selfId ?? t('bots.notLoggedIn') }}</span>
            </div>
            <StatusBadge :status="bot.status" :error="bot.error" />
          </div>
          <p class="bot-desc">
            <NTag size="small" :bordered="false" class="mode-tag">{{ connectionOf(bot).tag }}</NTag>
            <span class="mono" :title="connectionOf(bot).address">{{ connectionOf(bot).address }}</span>
          </p>
          <NSpace justify="space-between" align="center" @click.stop>
            <span class="sub">{{ t('bots.pluginCount', { count: bot.plugins.filter((p) => p.enabled).length }) }}</span>
            <NSwitch :value="bot.enabled" :loading="busy === bot.id" @update:value="(value: boolean) => toggle(bot, value)">
              <template #checked>{{ t('common.on') }}</template>
              <template #unchecked>{{ t('common.off') }}</template>
            </NSwitch>
          </NSpace>
        </NCard>
      </NGridItem>
    </NGrid>

    <NCard v-else-if="data.loadedBots">
      <NEmpty :description="t('bots.empty')">
        <template #extra>
          <NButton type="primary" @click="showCreate = true">{{ t('bots.add') }}</NButton>
        </template>
      </NEmpty>
    </NCard>

    <BotEditor v-model:show="showCreate" @created="(bot) => router.push(`/bots/${bot.id}`)" />
  </div>
</template>

<style scoped>
.bot-card {
  cursor: pointer;
}

.bot-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.bot-avatar {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(59, 74, 140, 0.12);
  color: #3b4a8c;
  flex: none;
}

.bot-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.bot-title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub {
  font-size: 12px;
  opacity: 0.6;
}

.mode-tag {
  margin-right: 6px;
}

.bot-desc {
  margin: 12px 0;
  opacity: 0.75;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
