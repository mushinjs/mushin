<script setup lang="ts">
import { Button, Spin } from '@mushinjs/ui'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../api'
import QrCode from './QrCode.vue'

/**
 * Creates a bot by scanning a QR code: starts the adapter's binding, shows its code, and polls
 * until the platform reports the new bot, then hands its config to the form.
 */
const props = defineProps<{ setup: { start: string; poll: string }; adapterId: string }>()
const emit = defineEmits<{ created: [config: Record<string, any>] }>()
const { t, te } = useI18n()

type State = 'loading' | 'waiting' | 'expired' | 'error'
const state = ref<State>('loading')
const qrcode = ref('')
const message = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false

const scanHint = () => (te(`bots.qr.scan.${props.adapterId}`) ? t(`bots.qr.scan.${props.adapterId}`) : t('bots.qr.scan.default'))

async function start() {
  clearTimeout(timer)
  state.value = 'loading'
  try {
    const task = await call<{ id: string; qrcode: string; interval?: number }>(props.setup.start, {})
    qrcode.value = task.qrcode
    state.value = 'waiting'
    poll(task.id, Math.max(1, task.interval ?? 2) * 1000)
  } catch (error) {
    state.value = 'error'
    message.value = (error as Error).message
  }
}

function poll(id: string, interval: number) {
  timer = setTimeout(async () => {
    if (stopped) return
    try {
      const result = await call<{ status: string; config?: Record<string, any>; message?: string }>(props.setup.poll, { id })
      if (stopped) return
      if (result.status === 'created' && result.config) return emit('created', result.config)
      if (result.status === 'expired') return void (state.value = 'expired')
      if (result.status === 'error') {
        state.value = 'error'
        message.value = result.message ?? ''
        return
      }
    } catch (error) {
      // A failed poll is retried; the code stays valid on the platform's side.
      console.warn('polling the QR setup failed', error)
    }
    poll(id, interval)
  }, interval)
}

onMounted(start)
onBeforeUnmount(() => {
  stopped = true
  clearTimeout(timer)
})
</script>

<template>
  <div class="qr-setup">
    <Spin v-if="state === 'loading'" :description="t('bots.qr.loading')" />
    <template v-else-if="state === 'waiting'">
      <QrCode :text="qrcode" />
      <div class="side">
        <p>{{ scanHint() }}</p>
        <p class="muted">{{ t('bots.qr.waiting') }}</p>
        <a :href="qrcode" target="_blank" rel="noopener" class="muted link">{{ t('bots.qr.openLink') }}</a>
      </div>
    </template>
    <div v-else class="side">
      <p>{{ state === 'expired' ? t('bots.qr.expired') : t('bots.qr.failed', { message }) }}</p>
      <Button size="small" @click="start">{{ t('bots.qr.retry') }}</Button>
    </div>
  </div>
</template>

<style scoped>
.qr-setup {
  display: flex;
  gap: 16px;
  align-items: center;
  min-height: 120px;
  flex-wrap: wrap;
}

.side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-width: 180px;
  align-items: flex-start;
}

.side p {
  margin: 0;
}

.muted {
  opacity: 0.65;
  font-size: 13px;
}

.link {
  color: inherit;
}
</style>
