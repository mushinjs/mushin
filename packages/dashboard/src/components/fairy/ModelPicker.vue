<script setup lang="ts">
import { Button, Popover, useToast } from '@mushinjs/ui'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDataStore } from '../../stores/data'
import { useConversation } from '../../stores/fairy'
import { useFairyDefaults } from './fairyDefaults'

/**
 * The model for the next messages, by provider. Picking one keeps the list open, so you can look again or
 * change the effort next to it; a click outside or Esc closes it. Providers fold, and stay as you left them;
 * a search opens them all. The footer saves the pick as Fairy's own default (also what /model opens).
 */
const { t } = useI18n()
const fairy = useConversation()
const data = useDataStore()
const defaults = useFairyDefaults()
const toast = useToast()

const show = ref(false)
const query = ref('')
const search = ref<HTMLInputElement>()

const FOLD_KEY = 'mushin.fairy.pickerGroups'
function readFolds(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') ?? {}
  } catch {
    return {}
  }
}
/** Providers opened or closed by hand; the rest start closed, except the one in use. */
const folds = ref<Record<string, boolean>>(readFolds())

const label = computed(() => {
  const { provider, model } = fairy.choice
  if (model) return model
  if (provider) return data.providers.find((item) => item.id === provider)?.defaultModel ?? data.profiles.find((item) => item.id === provider)?.name ?? provider
  return defaults.model.value ?? t('fairyPicker.default')
})
const isDefault = computed(() => !fairy.choice.provider && !fairy.choice.model)

/** Chat providers with their models, filtered by the search words. */
const groups = computed(() => {
  const words = query.value.trim().toLowerCase()
  return data.providers
    .filter((provider) => provider.capabilities?.includes('chat') ?? true)
    .map((provider) => {
      const models = provider.models.length ? provider.models : provider.defaultModel ? [provider.defaultModel] : []
      return {
        id: provider.id,
        name: provider.name,
        total: models.length,
        models: models.filter((model) => !words || model.toLowerCase().includes(words) || provider.name.toLowerCase().includes(words)),
      }
    })
    .filter((group) => group.models.length)
})
const modelCount = computed(() => groups.value.reduce((sum, group) => sum + group.total, 0))

/** The provider the next message goes to. */
const active = computed(() => fairy.choice.provider ?? defaults.provider.value ?? data.providers.find((item) => item.isDefault)?.id)

function isOpen(id: string) {
  if (query.value.trim() || groups.value.length === 1) return true
  return folds.value[id] ?? id === active.value
}

function toggleGroup(id: string) {
  folds.value = { ...folds.value, [id]: !isOpen(id) }
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(folds.value))
  } catch {}
}

function pick(provider?: string, model?: string) {
  fairy.choice = { ...fairy.choice, provider, model }
}

const saving = ref(false)
/** The pick differs from Fairy's own settings, so there is something to save. */
const canSave = computed(() => !isDefault.value || (fairy.choice.effort !== undefined && fairy.choice.effort !== defaults.effort.value))

async function saveDefault() {
  saving.value = true
  try {
    const choice = { ...fairy.choice }
    await defaults.save(choice)
    // The default is now this pick; the dock follows Fairy's settings again.
    fairy.choice = {}
    toast.success(t('fairyPicker.savedDefault', { model: choice.model ?? label.value }))
  } catch (error) {
    toast.error(String((error as Error).message ?? error))
  } finally {
    saving.value = false
  }
}

watch(show, async (open) => {
  if (!open) {
    query.value = ''
    return
  }
  defaults.load()
  await nextTick()
  search.value?.focus()
})
defaults.load()

/** Opens the list, for /model and "try another model". */
function open() {
  show.value = true
}
defineExpose({ open })
</script>

<template>
  <Popover v-model:show="show" placement="top" align="start" :padded="false" :width="300">
    <template #trigger>
      <button type="button" class="picker-chip" :title="t('fairyPicker.modelTitle')">
        <span class="picker-label">{{ label }}</span>
        <span class="i-lucide-chevron-down picker-caret" />
      </button>
    </template>
    <div class="picker">
      <div v-if="modelCount > 8" class="picker-search-wrap">
        <span class="i-lucide-search" />
        <input ref="search" v-model="query" class="picker-search" :placeholder="t('fairyPicker.search')">
      </div>
      <div class="picker-models">
        <button type="button" class="model-item" :class="{ current: isDefault }" @click="pick()">
          <span class="model-name">
            {{ t('fairyPicker.default') }}
            <small>{{ defaults.model.value ? t('fairyPicker.defaultIs', { model: defaults.model.value }) : t('fairyPicker.defaultHint') }}</small>
          </span>
          <span v-if="isDefault" class="i-lucide-check" />
        </button>
        <template v-for="group in groups" :key="group.id">
          <button type="button" class="model-group" :aria-expanded="isOpen(group.id)" @click="toggleGroup(group.id)">
            <span class="i-lucide-chevron-right group-caret" :class="{ open: isOpen(group.id) }" />
            <span class="group-name">{{ group.name }}</span>
            <span v-if="active === group.id" class="group-dot" />
            <span class="group-count">{{ group.models.length }}</span>
          </button>
          <template v-if="isOpen(group.id)">
            <button
              v-for="model in group.models"
              :key="model"
              type="button"
              class="model-item nested"
              :class="{ current: fairy.choice.provider === group.id && fairy.choice.model === model }"
              @click="pick(group.id, model)"
            >
              <span class="model-name">{{ model }}</span>
              <span v-if="fairy.choice.provider === group.id && fairy.choice.model === model" class="i-lucide-check" />
            </button>
          </template>
        </template>
        <div v-if="!groups.length && query" class="model-empty">{{ t('fairyPicker.noMatch') }}</div>
      </div>
      <div class="picker-foot">
        <span class="picker-hint">{{ t('fairyPicker.hint') }}</span>
        <Button size="tiny" secondary :disabled="!canSave" :loading="saving" @click="saveDefault">{{ t('fairyPicker.setDefault') }}</Button>
      </div>
    </div>
  </Popover>
</template>

<style scoped>
.picker-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  max-width: 100%;
  padding: 2px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg3);
  font-size: 12px;
  cursor: pointer;
}

.picker-chip:hover,
.picker-chip[data-state='open'] {
  background: var(--s2);
  color: var(--fg);
}

.picker-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-caret {
  flex: none;
  font-size: 12px;
}

.picker {
  display: flex;
  flex-direction: column;
  font-size: 13px;
}

.picker-search-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 8px 0;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--fg3);
}

.picker-search-wrap:focus-within {
  border-color: var(--primary);
}

.picker-search {
  flex: 1;
  min-width: 0;
  padding: 6px 0;
  border: none;
  background: none;
  color: var(--fg);
  font: inherit;
  outline: none;
}

.picker-models {
  display: flex;
  flex-direction: column;
  max-height: 320px;
  padding: 6px;
  overflow-y: auto;
}

.model-group {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--fg2);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.model-group:hover {
  background: var(--s2);
  color: var(--fg);
}

.group-caret {
  flex: none;
  font-size: 13px;
  transition: transform 0.12s;
}

.group-caret.open {
  transform: rotate(90deg);
}

.group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 500;
}

.group-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary);
}

.group-count {
  flex: none;
  color: var(--fg3);
  font-size: 11px;
}

.model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.model-item.nested {
  padding-left: 25px;
}

.model-item:hover {
  background: var(--s2);
}

.model-item.current {
  background: var(--primary-soft);
}

.model-item .i-lucide-check {
  flex: none;
  color: var(--primary);
}

.model-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-name small {
  color: var(--fg3);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-empty {
  padding: 8px;
  color: var(--fg3);
}

.picker-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px 8px 14px;
  border-top: 1px solid var(--line);
}

.picker-hint {
  color: var(--fg3);
  font-size: 11px;
}
</style>
