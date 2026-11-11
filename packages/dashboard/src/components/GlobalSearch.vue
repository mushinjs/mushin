<script setup lang="ts">
/**
 * Ctrl+K (⌘K on a Mac): one box to jump anywhere — a page, a bot, a flow, a persona, a plugin or a
 * provider — or to do a common thing such as starting a new flow.
 */
import { Modal } from '@mushinjs/ui'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call } from '../api'
import { avatarColor, initial } from '../botAvatar'
import { useAgentStore } from '../stores/agent'
import { useDataStore } from '../stores/data'
import { themeMode, useTheme } from '../theme'
import type { AppPlugin, FlowSummary, Persona } from '../types'
import { localize } from '../utils'
import type { NavGroup } from './nav'

const props = defineProps<{ pages: NavGroup[] }>()
const show = defineModel<boolean>('show', { default: false })

const { t, locale } = useI18n()
const router = useRouter()
const data = useDataStore()
const agent = useAgentStore()
const { isDark } = useTheme()

interface Result {
  key: string
  group: string
  label: string
  sub?: string
  /** An icon class, such as `i-lucide-plus`. */
  icon?: string
  /** A coloured initial instead of an icon, as the bot's avatar elsewhere. */
  avatar?: { id: string; name: string; src?: string }
  /** Extra words it can be found by. */
  words?: string
  run: () => void
}

// What is not in the stores is fetched each time the box opens, so it is never stale for long.
const flows = ref<FlowSummary[]>([])
const personas = ref<Persona[]>([])
const plugins = ref<AppPlugin[]>([])

async function load() {
  const [flowList, pluginList] = await Promise.all([
    call<FlowSummary[]>('flows.list').catch(() => []),
    call<AppPlugin[]>('plugins.list').catch(() => []),
  ])
  flows.value = flowList
  plugins.value = pluginList
  const hasPersonas = pluginList.some((plugin) => plugin.package === '@mushinjs/plugin-personas' && plugin.status === 'active')
  personas.value = hasPersonas ? await call<Persona[]>('personas.list').catch(() => []) : []
}

const query = ref('')
const active = ref(0)
const input = ref<HTMLInputElement>()
const list = ref<HTMLElement>()

watch(show, async (open) => {
  if (!open) return
  query.value = ''
  active.value = 0
  void load()
  await nextTick()
  input.value?.focus()
})

const go = (to: string | { path: string; query?: Record<string, string> }) => () => router.push(to)

const all = computed<Result[]>(() => {
  const g = {
    page: t('search.groups.pages'),
    action: t('search.groups.actions'),
    bot: t('search.groups.bots'),
    flow: t('search.groups.flows'),
    persona: t('search.groups.personas'),
    plugin: t('search.groups.plugins'),
    provider: t('search.groups.providers'),
  }
  return [
    ...props.pages.flatMap((group) => group.items.map((item): Result => ({
      key: `page:${item.key}`, group: g.page, label: item.label, sub: group.label, icon: item.icon, words: item.key, run: go(item.key),
    }))),
    { key: 'action:flow', group: g.action, label: t('flows.add'), icon: 'i-lucide-plus', words: 'new flow', run: go({ path: '/flows', query: { new: '1' } }) },
    { key: 'action:bot', group: g.action, label: t('bots.add'), icon: 'i-lucide-plus', words: 'new bot napcat', run: go({ path: '/bots', query: { new: '1' } }) },
    { key: 'action:persona', group: g.action, label: t('personas.add'), icon: 'i-lucide-plus', words: 'new persona', run: go({ path: '/personas', query: { persona: 'new' } }) },
    { key: 'action:agent', group: g.action, label: t('search.askAgent'), icon: 'i-lucide-sparkles', words: 'agent ai', run: () => (agent.open = true) },
    {
      key: 'action:theme',
      group: g.action,
      label: isDark.value ? t('layout.lightTheme') : t('layout.darkTheme'),
      icon: isDark.value ? 'i-lucide-sun' : 'i-lucide-moon',
      words: 'theme dark light',
      run: () => (themeMode.value = isDark.value ? 'light' : 'dark'),
    },
    ...data.bots.map((bot): Result => ({
      key: `bot:${bot.id}`, group: g.bot, label: bot.name, sub: bot.selfId ? `${bot.selfName ?? ''} ${bot.selfId}`.trim() : undefined,
      avatar: { id: bot.id, name: bot.name, src: bot.selfAvatar }, words: bot.id, run: go(`/bots/${bot.id}`),
    })),
    ...flows.value.map((flow): Result => ({
      key: `flow:${flow.id}`, group: g.flow, label: flow.name, sub: flow.description, icon: 'i-lucide-network',
      words: flow.triggers.map((item) => item.summary).join(' '), run: go(`/flows/${flow.id}`),
    })),
    ...personas.value.map((persona): Result => ({
      key: `persona:${persona.id}`, group: g.persona, label: persona.name, sub: persona.description, icon: 'i-lucide-circle-user',
      avatar: persona.avatar ? { id: persona.id, name: persona.name, src: persona.avatar } : undefined,
      words: persona.tags.join(' '), run: go({ path: '/personas', query: { persona: persona.id } }),
    })),
    ...plugins.value.map((plugin): Result => ({
      key: `plugin:${plugin.package}`, group: g.plugin, label: localize(plugin.manifest?.displayName, locale.value) || plugin.package,
      sub: plugin.package, icon: 'i-lucide-puzzle', run: go({ path: '/plugins', query: { highlight: plugin.package } }),
    })),
    ...data.providers.map((provider): Result => ({
      key: `provider:${provider.id}`, group: g.provider, label: provider.name, sub: provider.models.slice(0, 3).join('、'), icon: 'i-lucide-key-round',
      words: `${provider.type} ${provider.models.join(' ')}`, run: go({ path: '/providers', query: { highlight: provider.id } }),
    })),
  ]
})

/** How well a result matches: the name starting with the words beats containing them, which beats the rest. */
function score(result: Result, words: string) {
  const label = result.label.toLowerCase()
  if (label.startsWith(words)) return 3
  if (label.includes(words)) return 2
  if (`${result.sub ?? ''} ${result.words ?? ''}`.toLowerCase().includes(words)) return 1
  return 0
}

/** How many results each group shows; with nothing typed, only pages and actions show. */
const PER_GROUP = 6

const groups = computed(() => {
  const words = query.value.trim().toLowerCase()
  const picked = words
    ? all.value.map((result) => ({ result, score: score(result, words) })).filter((item) => item.score > 0)
    : all.value.filter((result) => result.key.startsWith('page:') || result.key.startsWith('action:')).map((result) => ({ result, score: 1 }))
  const byGroup = new Map<string, { result: Result; score: number }[]>()
  for (const item of picked) {
    const bucket = byGroup.get(item.result.group) ?? []
    bucket.push(item)
    byGroup.set(item.result.group, bucket)
  }
  // Groups with the best match come first; inside a group, better matches first.
  return [...byGroup.entries()]
    .map(([label, items]) => ({ label, items: items.sort((a, b) => b.score - a.score).slice(0, words ? PER_GROUP : 99).map((item) => item.result), best: Math.max(...items.map((item) => item.score)) }))
    .sort((a, b) => (words ? b.best - a.best : 0))
})

const flat = computed(() => groups.value.flatMap((group) => group.items))
watch(query, () => (active.value = 0))

function pick(result: Result | undefined) {
  if (!result) return
  show.value = false
  result.run()
}

async function move(step: number) {
  const count = flat.value.length
  if (!count) return
  active.value = (active.value + step + count) % count
  await nextTick()
  list.value?.querySelector('.result.active')?.scrollIntoView({ block: 'nearest' })
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') move(1)
  else if (event.key === 'ArrowUp') move(-1)
  else if (event.key === 'Enter' && !event.isComposing) pick(flat.value[active.value])
  else return
  event.preventDefault()
}

const indexOf = (result: Result) => flat.value.indexOf(result)
const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
</script>

<template>
  <Modal v-model:show="show" bare :label="t('search.title')" class="search-modal">
    <div class="search" @keydown="onKeydown">
      <div class="search-input">
        <span class="i-lucide-search search-icon" />
        <input
          ref="input"
          v-model="query"
          type="text"
          :placeholder="t('search.placeholder')"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="search-results"
          :aria-expanded="true"
          :aria-activedescendant="flat[active] ? `search-${active}` : undefined"
          spellcheck="false"
          autocomplete="off"
        >
        <kbd class="esc">Esc</kbd>
      </div>
      <div id="search-results" ref="list" class="results" role="listbox">
        <section v-for="group in groups" :key="group.label" class="group">
          <div class="group-title">{{ group.label }}</div>
          <button
            v-for="result in group.items"
            :id="`search-${indexOf(result)}`"
            :key="result.key"
            type="button"
            role="option"
            class="result"
            :class="{ active: indexOf(result) === active }"
            :aria-selected="indexOf(result) === active"
            @mousemove="active = indexOf(result)"
            @click="pick(result)"
          >
            <img v-if="result.avatar?.src" :src="result.avatar.src" alt="" class="result-avatar">
            <span v-else-if="result.avatar" class="result-avatar" :style="{ background: avatarColor(result.avatar.id) }" aria-hidden="true">{{ initial(result.avatar.name) }}</span>
            <span v-else class="result-icon"><span :class="result.icon ?? 'i-lucide-messages-square'" /></span>
            <span class="result-text">
              <span class="result-label">{{ result.label }}</span>
              <span v-if="result.sub" class="result-sub">{{ result.sub }}</span>
            </span>
            <span v-if="indexOf(result) === active" class="i-lucide-arrow-right result-go" />
          </button>
        </section>
        <p v-if="!flat.length" class="nothing">{{ t('search.nothing', { query: query.trim() }) }}</p>
      </div>
      <footer class="search-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> {{ t('search.navigate') }}</span>
        <span><kbd>Enter</kbd> {{ t('search.open') }}</span>
        <span class="spacer" />
        <span><kbd>{{ isMac ? '⌘' : 'Ctrl' }}</kbd><kbd>K</kbd> {{ t('search.toggle') }}</span>
      </footer>
    </div>
  </Modal>
</template>

<style scoped>
.search {
  width: min(600px, calc(100vw - 32px));
  /* A fixed height, so the box does not jump about as results come and go. */
  height: min(520px, calc(100vh - 96px));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--s1);
  color: var(--fg);
  box-shadow: 0 24px 64px rgba(10, 12, 30, 0.3);
  overflow: hidden;
}

.search-input {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  height: 52px;
  border-bottom: 1px solid var(--line);
}

.search-icon {
  color: var(--fg3);
  font-size: 18px;
}

.search-input input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  outline: none;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 15px;
}

.search-input input::placeholder {
  color: var(--fg3);
}

kbd {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border: 1px solid var(--line);
  border-bottom-width: 2px;
  border-radius: 5px;
  background: var(--s2);
  color: var(--fg2);
  font: 11px/1 var(--mono);
}

kbd + kbd {
  margin-left: 3px;
}

.results {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.group + .group {
  margin-top: 4px;
}

.group-title {
  padding: 8px 10px 4px;
  font-size: 12px;
  color: var(--fg3);
}

.result {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 6px 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.result.active {
  background: var(--primary-soft);
}

.result-icon,
.result-avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 7px;
}

.result-icon {
  background: var(--s2);
  color: var(--fg2);
  font-size: 15px;
}

.active .result-icon {
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 14%, var(--s1));
}

.result-avatar {
  border-radius: 50%;
  object-fit: cover;
  color: #fff;
  font-size: 12px;
  font-weight: 650;
}

.result-text {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.result-label {
  flex: none;
  max-width: 60%;
  overflow: hidden;
  font-size: 14px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.result-sub {
  min-width: 0;
  overflow: hidden;
  font-size: 12.5px;
  color: var(--fg3);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.result-go {
  flex: none;
  color: var(--primary);
  font-size: 14px;
}

.nothing {
  margin: 0;
  padding: 32px 16px;
  font-size: 13px;
  color: var(--fg3);
  text-align: center;
}

.search-foot {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 14px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--fg3);
}

.search-foot .spacer {
  flex: 1;
}

@media (max-width: 600px) {
  .search-foot {
    display: none;
  }
}
</style>
