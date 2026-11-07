<script setup lang="ts">
/**
 * Provider presets as a grid of icon cards, grouped by provider type. The first card starts from
 * scratch; picking any card emits its value (`type:preset`, or `custom`).
 */
import { Input } from '@mushin/ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { avatarColor, presetIcon } from '../presetIcons'
import type { ProviderType } from '../types'
import { localize } from '../utils'

const props = defineProps<{
  types: ProviderType[]
  /** The picked card's value. */
  value?: string
}>()

const emit = defineEmits<{ select: [value: string] }>()
const { t, locale } = useI18n()
const query = ref('')

interface Card {
  value: string
  label: string
  icon?: string
  initial: string
  color: string
}

const groups = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return props.types.flatMap((type) => {
    const typeName = localize(type.displayName, locale.value)
    const cards: Card[] = type.presets.flatMap((preset) => {
      const label = localize(preset.label, locale.value)
      const haystack = `${label} ${preset.id} ${typeName} ${String(preset.config.baseURL ?? '')}`.toLowerCase()
      if (needle && !haystack.includes(needle)) return []
      return [{
        value: `${type.id}:${preset.id}`,
        label,
        icon: presetIcon(type.id, preset.id),
        initial: [...label.trim()][0]?.toUpperCase() ?? '?',
        color: avatarColor(label),
      }]
    })
    return cards.length ? [{ id: type.id, name: typeName, cards }] : []
  })
})

const total = computed(() => props.types.reduce((sum, type) => sum + type.presets.length, 0))
</script>

<template>
  <div class="preset-grid">
    <Input v-if="total > 8" v-model:value="query" size="small" clearable :placeholder="t('providers.presetSearch')">
      <template #prefix><span class="i-lucide-search text-[13px] opacity-60" /></template>
    </Input>
    <div class="scroller">
      <div v-if="!query.trim()" class="cards">
        <button type="button" class="card" :class="{ active: value === 'custom' }" :aria-pressed="value === 'custom'" @click="emit('select', 'custom')">
          <span class="tile"><span class="i-lucide-sliders-horizontal text-[18px]" /></span>
          <span class="label">{{ t('providers.presetCustom') }}</span>
        </button>
      </div>
      <section v-for="group in groups" :key="group.id" class="group">
        <h4>{{ group.name }}</h4>
        <div class="cards">
          <button
            v-for="card in group.cards"
            :key="card.value"
            type="button"
            class="card"
            :class="{ active: value === card.value }"
            :aria-pressed="value === card.value"
            :title="card.label"
            @click="emit('select', card.value)"
          >
            <span v-if="card.icon" class="tile"><span :class="card.icon" class="text-[20px]" /></span>
            <span v-else class="tile letter" :style="{ background: card.color }">{{ card.initial }}</span>
            <span class="label">{{ card.label }}</span>
          </button>
        </div>
      </section>
      <p v-if="!groups.length" class="empty">{{ t('providers.presetNone') }}</p>
    </div>
  </div>
</template>

<style scoped>
.preset-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.scroller {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 296px;
  overflow-y: auto;
  padding: 2px;
  margin: -2px;
}

.group h4 {
  margin: 0 0 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--fg3);
}

/* As many columns as fit; two at the narrowest. */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(132px, calc(50% - 4px)), 1fr));
  gap: 8px;
}

.card {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 44px;
  padding: 6px 10px 6px 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--s1);
  color: var(--fg);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.card:hover {
  border-color: var(--line-strong);
  background: var(--s2);
}

.card:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--focus);
}

.card.active {
  border-color: var(--primary);
  background: var(--primary-soft);
}

.tile {
  display: grid;
  flex: none;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 7px;
  background: var(--s2);
}

.card.active .tile {
  background: var(--s1);
}

.tile.letter {
  color: #fff;
  font-weight: 650;
  font-size: 13px;
}

/* Long names such as "DeepSeek (Anthropic API)" take a second line rather than being cut. */
.label {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.empty {
  margin: 4px 0;
  color: var(--fg3);
  font-size: 12.5px;
}
</style>
