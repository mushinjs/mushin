<script setup lang="ts">
import { Button } from '@mushinjs/ui'
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { dismissResult, initUpdates, updates } from '../../updates'

/** Covers the page while Mushin.js restarts or updates, then says how it went. */
const { t } = useI18n()
// The first signed-in page loads what there is to update, for the sidebar's count and the Plugins page.
onMounted(initUpdates)

const pending = computed(() => updates.pending)
const result = computed(() => updates.result)
const value = computed(() => result.value?.value)
const officialTo = computed(() => (value.value?.to && value.value.to !== value.value.from ? value.value.to : undefined))
const pluginsOnly = computed(() => (value.value?.packages ?? []).filter((spec) => !spec.startsWith('@mushinjs/')))

function reload() {
  dismissResult()
  location.reload()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="pending || result" class="overlay" role="dialog" aria-modal="true" :aria-busy="!!pending">
      <div class="card">
        <template v-if="pending">
          <span class="i-lucide-loader-circle spin big" />
          <h2>{{ pending.kind === 'update' ? t('updates.updating') : t('updates.restarting') }}</h2>
          <p>{{ pending.kind === 'update' ? t('updates.updatingHint', { list: (pending.packages ?? []).join(t('plugins.listSeparator')) }) : t('updates.restartingHint') }}</p>
        </template>
        <template v-else-if="result?.kind === 'restart'">
          <span class="i-lucide-circle-check big ok" />
          <h2>{{ t('updates.restarted') }}</h2>
          <div class="actions"><Button type="primary" @click="dismissResult">{{ t('updates.close') }}</Button></div>
        </template>
        <template v-else-if="value?.ok">
          <span class="i-lucide-circle-check big ok" />
          <h2>{{ officialTo ? t('updates.done', { version: officialTo }) : t('updates.donePlugins', { list: pluginsOnly.join(t('plugins.listSeparator')) }) }}</h2>
          <p>{{ t('updates.doneHint') }}</p>
          <div class="actions">
            <Button @click="dismissResult">{{ t('updates.close') }}</Button>
            <Button type="primary" @click="reload">{{ t('updates.reload') }}</Button>
          </div>
        </template>
        <template v-else-if="value">
          <span class="i-lucide-circle-x big bad" />
          <h2>{{ t('updates.failed') }}</h2>
          <p v-if="value.error" class="reason">{{ t('updates.failedReason', { error: value.error }) }}</p>
          <p v-if="value.log" class="mono log">{{ t('updates.log', { path: value.log }) }}</p>
          <div class="actions"><Button type="primary" @click="dismissResult">{{ t('updates.close') }}</Button></div>
        </template>
        <template v-else>
          <span class="i-lucide-circle-help big warn" />
          <h2>{{ t('updates.unknown') }}</h2>
          <p>{{ t('updates.unknownHint') }}</p>
          <div class="actions"><Button type="primary" @click="dismissResult">{{ t('updates.close') }}</Button></div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: color-mix(in srgb, var(--bg, #000) 70%, transparent);
  backdrop-filter: blur(4px);
}

.card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: min(460px, 100%);
  padding: 32px 28px 24px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--s1);
  box-shadow: var(--shadow-pop);
  text-align: center;
}

h2 {
  margin: 4px 0 0;
  font-size: 18px;
  font-weight: 650;
}

p {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--fg2);
}

.reason {
  color: var(--bad);
}

.log {
  font-size: 12px;
  overflow-wrap: anywhere;
}

.big {
  font-size: 40px;
}

.ok { color: var(--ok); }
.bad { color: var(--bad); }
.warn { color: var(--warn); }

.spin {
  color: var(--primary);
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
</style>
