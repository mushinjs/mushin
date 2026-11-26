<script setup lang="ts">
import { Button, Card, Select, Tooltip, useConfirm, useToast } from '@mushinjs/ui'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../../api'
import { loadUpdates, restartApp, updateCount, updates } from '../../updates'
import UpdateDialog from '../updates/UpdateDialog.vue'

/** Settings → About: the version, the update channel, checking now, updating, and restarting. */
const { t, locale } = useI18n()
const message = useToast()
const dialog = useConfirm()

const info = computed(() => updates.info)
const dialogOpen = ref(false)
const saving = ref(false)

onMounted(() => loadUpdates())

const channels = computed(() => (['auto', 'latest', 'next'] as const).map((value) => ({ value, label: t(`updates.channels.${value}`) })))

async function setChannel(channel: 'auto' | 'latest' | 'next') {
  saving.value = true
  try {
    await call('system.updateChannel', { channel })
    await loadUpdates()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

const checkedAt = computed(() => (info.value?.checkedAt ? new Date(info.value.checkedAt).toLocaleString(locale.value) : '—'))

function restart() {
  dialog.warning({
    title: t('updates.restartTitle'),
    content: t('updates.restartBody'),
    positiveText: t('updates.restart'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => restartApp().catch((error) => message.error((error as Error).message)),
  })
}
</script>

<template>
  <Card v-if="updates.available && info" :title="t('updates.settingsTitle')" size="small">
    <div class="rows">
      <p v-if="info.mode === 'development'" class="faint">{{ t('updates.development') }}</p>
      <template v-else>
        <div class="row">
          <span class="label">{{ t('updates.current') }}</span>
          <span class="mono">{{ info.version }}</span>
          <span v-if="info.mushin?.available" class="avail">{{ t('updates.mushinAvailable', { version: info.mushin.available }) }}</span>
          <span v-else class="faint">{{ t('updates.upToDate') }}</span>
        </div>
        <div class="row">
          <span class="label">{{ t('updates.channel') }}</span>
          <Select class="channel" size="small" :value="info.channel" :options="channels" :loading="saving" @update:value="setChannel" />
        </div>
        <div class="row">
          <span class="faint">{{ t('updates.checkedAt', { time: checkedAt }) }}</span>
          <Button size="small" :loading="updates.checking" @click="loadUpdates(true)">{{ t('updates.checkNow') }}</Button>
          <Button v-if="updateCount" size="small" type="primary" :disabled="!info.supervised" @click="dialogOpen = true">{{ t('updates.apply') }}</Button>
        </div>
        <p v-if="info.error" class="bad">{{ t('updates.checkFailed', { error: info.error }) }}</p>
      </template>
      <div class="row">
        <Tooltip :disabled="info.supervised" :max-width="320">
          <template #trigger><span><Button size="small" icon="i-lucide-rotate-ccw" :disabled="!info.supervised" @click="restart">{{ t('updates.restart') }}</Button></span></template>
          {{ t('updates.needsSupervisor') }}
        </Tooltip>
      </div>
      <p v-if="!info.supervised" class="faint">{{ t('updates.needsSupervisor') }}</p>
    </div>
    <UpdateDialog v-model:show="dialogOpen" />
  </Card>
</template>

<style scoped>
.rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.label {
  min-width: 72px;
  color: var(--fg3);
}

.channel {
  width: 280px;
}

.avail {
  color: var(--primary);
}

.faint,
.bad {
  margin: 0;
  color: var(--fg3);
}

.bad {
  color: var(--bad);
}
</style>
