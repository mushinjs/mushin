<script setup lang="ts">
import { Alert, Button, Checkbox, Modal, useToast } from '@mushinjs/ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { applyUpdates, updates } from '../../updates'

/**
 * What an update will do, before it starts: the new Mushin.js version (all official packages together), the plugins
 * to update with it (compatible ones can be ticked), and that bots go offline and a failure rolls back.
 */
const props = defineProps<{
  /** Ticked when it opens: `mushin` for Mushin.js, or plugin package names. */
  preset?: string[]
}>()
const show = defineModel<boolean>('show', { required: true })
const { t } = useI18n()
const message = useToast()

const info = computed(() => updates.info)
const mushin = computed(() => (info.value?.mushin?.available ? info.value.mushin : undefined))
const plugins = computed(() => (info.value?.plugins ?? []).filter((plugin) => plugin.available))

const withMushin = ref(true)
const chosen = ref(new Set<string>())
const busy = ref(false)

watch(show, (open) => {
  if (!open) return
  const preset = props.preset
  withMushin.value = !!mushin.value && (!preset || preset.includes('mushin'))
  chosen.value = new Set(plugins.value.filter((plugin) => plugin.compatible && (!preset || preset.includes(plugin.package))).map((plugin) => plugin.package))
})

function tick(pkg: string, on: boolean) {
  const next = new Set(chosen.value)
  if (on) next.add(pkg)
  else next.delete(pkg)
  chosen.value = next
}

const packages = computed(() => [...(withMushin.value && mushin.value ? mushin.value.packages : []), ...chosen.value])

async function start() {
  busy.value = true
  try {
    await applyUpdates(packages.value)
    show.value = false
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal v-model:show="show" :title="t('updates.dialogTitle')" :width="540">
    <div class="body">
      <label v-if="mushin" class="choice main">
        <Checkbox :checked="withMushin" @update:checked="(on) => (withMushin = on)" />
        <span class="text">
          <strong>{{ t('updates.versionChange', { from: mushin.current, to: mushin.available }) }}</strong>
          <small>{{ t('updates.officialTogether', { list: mushin.packages.join(t('plugins.listSeparator')) }) }}</small>
        </span>
      </label>

      <template v-if="plugins.length">
        <h4>{{ t('updates.pluginsTitle') }}</h4>
        <label v-for="plugin in plugins" :key="plugin.package" class="choice" :class="{ off: !plugin.compatible }">
          <Checkbox :checked="chosen.has(plugin.package)" :disabled="!plugin.compatible" @update:checked="(on) => tick(plugin.package, on)" />
          <span class="text">
            <span><span class="mono">{{ plugin.package }}</span> <span class="chip mono">{{ plugin.current }} → {{ plugin.available }}</span></span>
            <small v-if="!plugin.compatible" class="bad">{{ t('updates.incompatible', { range: plugin.requires }) }}</small>
          </span>
        </label>
      </template>

      <Alert type="warning" class="notes">
        <ul>
          <li>{{ t('updates.offline') }}</li>
          <li>{{ t('updates.rollback') }}</li>
        </ul>
      </Alert>
      <p v-if="!packages.length" class="faint">{{ t('updates.nothing') }}</p>
    </div>
    <template #footer>
      <Button @click="show = false">{{ t('common.cancel') }}</Button>
      <Button type="primary" :loading="busy" :disabled="!packages.length" @click="start">{{ t('updates.apply') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

h4 {
  margin: 6px 0 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg3);
}

.choice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: pointer;
}

.choice.main {
  border-color: var(--primary);
  background: var(--primary-soft);
}

.choice.off {
  opacity: 0.7;
  cursor: default;
}

.text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  font-size: 13.5px;
}

.text small {
  color: var(--fg2);
  font-size: 12px;
  line-height: 1.5;
}

.text small.bad {
  color: var(--bad);
}

.chip {
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--s2);
  font-size: 11.5px;
}

.notes ul {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.7;
}

.faint {
  margin: 0;
  font-size: 12.5px;
  color: var(--fg3);
}
</style>
