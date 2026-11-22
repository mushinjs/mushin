<script setup lang="ts">
import { Tag } from '@mushinjs/ui'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFairyStore } from '../../stores/fairy'
import { useFairySceneStore } from '../../stores/fairyScene'
import type { FairyCommands, FairySkill } from '../../types'

/** One row: a Fairy command, a bot command or a skill. */
export type PaletteItem =
  | { kind: 'builtin'; key: string; name: string; description: string }
  | { kind: 'bot'; key: string; name: string; description: string; command: FairyCommands['bots'][number] }
  | { kind: 'skill'; key: string; name: string; description: string; skill: FairySkill; recommended: boolean }

const props = defineProps<{
  /** `/` lists commands and skills, `$` only skills. */
  mode: '/' | '$'
  query: string
  /** Scene key, so skills recommended here come first. */
  scene: string
}>()
const emit = defineEmits<{ pick: [item: PaletteItem] }>()

const { t, locale } = useI18n()
const fairy = useFairyStore()
const scenes = useFairySceneStore()
const active = ref(0)
const listEl = ref<HTMLElement>()

const matches = (...texts: (string | undefined)[]) => {
  const query = props.query.toLowerCase()
  return !query || texts.some((text) => text?.toLowerCase().includes(query))
}

const skillItems = computed<PaletteItem[]>(() => fairy.skills
  .filter((skill) => skill.enabled && matches(skill.id, skill.name, skill.description))
  .map((skill) => ({ kind: 'skill' as const, key: `skill:${skill.id}`, name: skill.name, description: skill.description, skill, recommended: !!skill.scenes?.includes(props.scene) || scenes.skills.includes(skill.id) }))
  .sort((a, b) => Number(b.recommended) - Number(a.recommended)))

const groups = computed(() => {
  if (props.mode === '$') return [{ title: t('fairyPalette.skills'), items: skillItems.value }]
  const builtin: PaletteItem[] = fairy.commands.builtin
    .filter((command) => matches(command.name))
    .map((command) => ({
      kind: 'builtin',
      key: `builtin:${command.name}`,
      name: command.name,
      description: locale.value === 'zh-CN' ? command['zh-CN'] ?? command.description : command.description,
    }))
  // A command on several bots is listed once per bot, so the user picks where it runs.
  const bots: PaletteItem[] = fairy.commands.bots
    .filter((command) => matches(command.name, command.description, command.botName))
    .map((command) => ({ kind: 'bot', key: `bot:${command.bot}:${command.name}`, name: command.name, description: command.description ?? '', command }))
  return [
    { title: t('fairyPalette.fairyCommands'), items: builtin },
    { title: t('fairyPalette.botCommands'), items: bots },
    { title: t('fairyPalette.skills'), items: skillItems.value },
  ].filter((group) => group.items.length)
})

const flat = computed(() => groups.value.flatMap((group) => group.items))

watch(() => [props.query, props.mode], () => (active.value = 0))

function sourceLabel(item: PaletteItem) {
  if (item.kind === 'builtin') return t('fairyPalette.source.builtin')
  if (item.kind === 'bot') return item.command.botName ?? item.command.bot
  if (item.skill.source === 'plugin') return item.skill.plugin ?? t('fairyPalette.source.plugin')
  return t(`fairyPalette.source.${item.skill.source}`)
}

async function move(step: number) {
  if (!flat.value.length) return
  active.value = (active.value + step + flat.value.length) % flat.value.length
  await nextTick()
  listEl.value?.querySelector('.row.active')?.scrollIntoView({ block: 'nearest' })
}

/** Picks the highlighted row; false when nothing matches. */
function choose() {
  const item = flat.value[active.value]
  if (!item) return false
  emit('pick', item)
  return true
}

defineExpose({ move, choose, count: () => flat.value.length })
</script>

<template>
  <div ref="listEl" class="palette" role="listbox">
    <div v-if="!flat.length" class="empty">{{ mode === '$' ? t('fairyPalette.noSkills') : t('fairyPalette.none') }}</div>
    <template v-for="group in groups" :key="group.title">
      <div class="group">{{ group.title }}</div>
      <button
        v-for="item in group.items"
        :key="item.key"
        type="button"
        role="option"
        class="row"
        :class="{ active: flat[active]?.key === item.key }"
        :aria-selected="flat[active]?.key === item.key"
        @mouseenter="active = flat.indexOf(item)"
        @mousedown.prevent="emit('pick', item)"
      >
        <span class="icon text-[16px]" :class="item.kind === 'builtin' ? 'i-lucide-terminal' : item.kind === 'bot' ? 'i-lucide-message-circle-more' : item.recommended ? 'i-lucide-zap' : 'i-lucide-puzzle'" />
        <span class="name">{{ item.kind === 'skill' ? item.name : `/${item.name}` }}</span>
        <span class="desc">{{ item.description }}</span>
        <Tag v-if="item.kind === 'skill' && item.recommended" size="tiny" type="success">{{ t('fairyPalette.recommended') }}</Tag>
        <span class="source">{{ sourceLabel(item) }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.palette {
  max-height: 280px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid rgba(127, 127, 127, 0.25);
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--raised);
  color: var(--fg2);
  box-shadow: var(--shadow-pop);
}

.group {
  font-size: 12px;
  opacity: 0.55;
  padding: 6px 8px 4px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.row.active {
  background: var(--primary-soft);
}

.icon {
  opacity: 0.7;
  flex: none;
}

.name {
  font-weight: 500;
  flex: none;
}

.desc {
  flex: 1;
  min-width: 0;
  opacity: 0.55;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source {
  flex: none;
  font-size: 12px;
  opacity: 0.5;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  padding: 10px;
  font-size: 13px;
  opacity: 0.6;
}
</style>
