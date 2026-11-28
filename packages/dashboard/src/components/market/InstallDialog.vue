<script setup lang="ts">
import { Alert, Button, Checkbox, Modal, useToast } from '@mushinjs/ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../../api'
import { installPackage, type MarketDetail, type MarketItem } from '../../market'
import { localize } from '../../utils'

/**
 * Before installing a market package: the version, the plugins that come with it, who published it and when, and for
 * a third-party plugin that its code runs with Mushin.js's rights. Emits `installed` when it went in without a restart.
 */
const props = defineProps<{ entry?: MarketItem }>()
const show = defineModel<boolean>('show', { required: true })
const emit = defineEmits<{ installed: [name: string, enable: boolean] }>()
const { t, locale } = useI18n()
const message = useToast()

const detail = ref<MarketDetail>()
const enableAfter = ref(true)
const busy = ref(false)

watch(show, async (open) => {
  detail.value = undefined
  enableAfter.value = props.entry?.kind === 'app'
  if (open && props.entry) detail.value = await call<MarketDetail>('market.package', { name: props.entry.name }).catch(() => undefined)
})

const name = computed(() => (props.entry ? localize(props.entry.displayName, locale.value) || props.entry.name : ''))
const updated = computed(() => (props.entry?.updatedAt ? new Date(props.entry.updatedAt).toLocaleString(locale.value) : ''))

async function install() {
  if (!props.entry) return
  busy.value = true
  try {
    const result = await installPackage(props.entry.name)
    show.value = false
    if (!result.restart) {
      message.success(t('market.installedNow', { name: name.value }))
      emit('installed', props.entry.name, enableAfter.value)
    }
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal v-model:show="show" :title="t('market.dialogTitle', { name })" :width="540">
    <div v-if="entry" class="body">
      <div class="head">
        <span class="mono pkg">{{ entry.name }}</span>
        <span class="mono version">{{ t('market.version', { version: entry.choice.version ?? entry.version }) }}</span>
        <span v-if="entry.official" class="badge official">{{ t('market.official') }}</span>
        <span v-if="entry.trusted" class="badge trusted" :title="t('market.trustedHint')">{{ t('market.trusted') }}</span>
        <span v-if="entry.curated" class="badge curated">{{ t('market.curated') }}</span>
      </div>
      <p v-if="entry.description" class="desc">{{ localize(entry.description, locale) }}</p>

      <div v-if="detail?.brings.length" class="brings">
        <span>{{ t('market.brings') }}</span>
        <ul>
          <li v-for="dep in detail.brings" :key="dep.name" class="mono">
            {{ dep.inMarket ? `${dep.name}@${dep.version ?? '?'}` : t('market.bringsMissing', { name: dep.name }) }}
          </li>
        </ul>
      </div>

      <Alert v-if="!entry.official" type="warning">
        <p class="warn">{{ t('market.warning') }}</p>
        <p class="meta">
          {{ entry.publisher ? t('market.publisher', { name: entry.publisher }) : t('market.noPublisher') }}
          <template v-if="updated"> · {{ t('market.publishedAt', { time: updated }) }}</template>
        </p>
      </Alert>
      <p class="note">{{ t('market.restartNote') }}</p>
      <Checkbox v-if="entry.kind === 'app'" :checked="enableAfter" @update:checked="(on) => (enableAfter = on)">{{ t('market.enableAfter') }}</Checkbox>
    </div>
    <template #footer>
      <Button @click="show = false">{{ t('common.cancel') }}</Button>
      <Button type="primary" :loading="busy" :disabled="!entry?.choice.version || detail?.brings.some((dep) => !dep.inMarket)" @click="install">{{ t('market.install') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13.5px;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.pkg {
  font-weight: 600;
}

.version {
  color: var(--fg2);
  font-size: 12.5px;
}

.desc,
.note,
.warn,
.meta {
  margin: 0;
  line-height: 1.6;
}

.note,
.meta {
  color: var(--fg2);
  font-size: 12.5px;
}

.meta {
  margin-top: 4px;
}

.brings ul {
  margin: 4px 0 0;
  padding-left: 20px;
}

.badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 11px;
}

.badge.official { background: var(--primary-soft); color: var(--primary); }
.badge.trusted { background: var(--ok-soft); color: var(--ok); }
.badge.curated { background: var(--warn-soft); color: var(--warn); }
</style>
