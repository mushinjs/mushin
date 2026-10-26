import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { call, on } from '../api'
import { i18n } from '../i18n'
import { router } from '../router'
import type { AgentScene } from '../types'
import { useDataStore } from './data'

/** A suggestion for the current page: clicking it sends `prompt`, with `skill` applied when set. */
export interface Recommendation {
  id: string
  text: string
  prompt: string
  skill?: string
  /** Shown in the bar above the input while a conversation is open; otherwise only on the welcome screen. */
  urgent?: boolean
}

/** What the user changed for one page on the Agent page. */
export interface SceneProfile {
  hint?: string
  welcome?: string
  recommendations?: { text: string; prompt?: string; skill?: string }[]
  hidden?: string[]
  skills?: string[]
  autoShow?: boolean
}

/** Facts a page knows better than the route, such as the open flow's name and error count. */
export interface PageFacts {
  label?: string
  state?: Record<string, string | number | boolean>
  resource?: string
}

/** Pages the Agent knows, in the order the Agent page lists them. */
export const SCENES = ['overview', 'setup', 'providers', 'bots', 'botDetail', 'flows', 'flowEditor', 'personas', 'plugins', 'logs', 'agent'] as const

/** The built-in suggestions each page can show (each only when its condition holds), for the Agent page. */
export const SCENE_RECOMMENDATIONS: Record<string, string[]> = {
  overview: ['connect', 'status', 'provider'],
  setup: ['connectDeepSeek', 'connectOllama', 'providerFailed'],
  providers: ['connectDeepSeek', 'connectOllama', 'providerFailed'],
  bots: ['connectQQ', 'tryDemo', 'botsFailing'],
  botDetail: ['botOffline', 'enableChat', 'flowTemplate', 'botCommands'],
  flows: ['flowCheckin', 'flowKeyword', 'flowService', 'flowNew'],
  flowEditor: ['flowFix', 'flowExplain', 'flowTests'],
  personas: ['connect', 'status', 'provider'],
  plugins: ['pluginsFailed'],
  logs: ['connect', 'status', 'provider'],
  agent: ['connect', 'status', 'provider'],
}

const t = (key: string, values: Record<string, unknown> = {}) => i18n.global.t(key, values)

/** Scene kind of a dashboard path. */
export function sceneKey(path: string) {
  const [, first, id] = path.split('/')
  if (first === 'bots') return id ? 'botDetail' : 'bots'
  if (first === 'flows') return id ? 'flowEditor' : 'flows'
  return (SCENES as readonly string[]).includes(first) ? first : 'overview'
}

/**
 * Works out which page the user is on and what the Agent should offer there. Recommendations come
 * from the local rules below, so they cost no tokens.
 */
export const useAgentSceneStore = defineStore('agentScene', () => {
  const data = useDataStore()
  const path = computed(() => router.currentRoute.value.path)
  const key = computed(() => sceneKey(path.value))
  const facts = ref<PageFacts>()
  /** Counts loaded for the page: flows on /flows, failed plugins on /plugins. */
  const counts = ref<{ flows?: number; failedPlugins?: string[] }>({})
  const dismissed = ref(new Set<string>())
  const profiles = ref<Record<string, SceneProfile>>({})
  const profile = computed<SceneProfile>(() => profiles.value[key.value] ?? {})

  async function refreshProfiles() {
    profiles.value = (await call<{ profiles: Record<string, SceneProfile> }>('agent.profiles.list')).profiles
  }

  let bound = false
  function bind() {
    if (bound) return
    bound = true
    on('agent/changed', () => refreshProfiles().catch(() => {}))
    refreshProfiles().catch(() => {})
  }

  watch(key, async (scene) => {
    try {
      if (scene === 'flows') counts.value = { ...counts.value, flows: (await call<unknown[]>('flows.list')).length }
      if (scene === 'plugins') {
        const plugins = await call<{ package: string; status: string }[]>('plugins.list')
        counts.value = { ...counts.value, failedPlugins: plugins.filter((plugin) => plugin.status === 'failed').map((plugin) => plugin.package) }
      }
    } catch {}
  }, { immediate: true })

  /** Lets a page describe itself; the page clears it when it unmounts. */
  function publish(next: PageFacts | undefined) {
    facts.value = next
  }

  const bot = computed(() => (key.value === 'botDetail' ? data.bots.find((item) => item.id === path.value.split('/')[2]) : undefined))

  const scene = computed<AgentScene>(() => {
    const name = t(`agentScene.name.${key.value}`)
    let label = name
    const state: Record<string, string | number | boolean> = { ...facts.value?.state }
    let resource = facts.value?.resource
    if (bot.value) {
      label = `${name} · ${bot.value.name} · ${t(`status.${bot.value.status}`)}`
      state.status = bot.value.status
      if (bot.value.error) state.error = bot.value.error
      state.plugins = bot.value.plugins.filter((plugin) => plugin.enabled).length
      resource ??= `bot:${bot.value.id}`
    } else if (facts.value?.label) {
      label = `${name} · ${facts.value.label}`
    }
    return { key: key.value, label, hint: profile.value.hint?.trim() || t(`agentScene.hint.${key.value}`), ...(Object.keys(state).length ? { state } : {}), ...(resource ? { resource } : {}) }
  })

  const recommendations = computed<Recommendation[]>(() => {
    const list: Recommendation[] = []
    const add = (id: string, prompt: string, options: { skill?: string; urgent?: boolean; values?: Record<string, unknown> } = {}) => {
      list.push({ id, text: t(`agentScene.rec.${id}`, options.values), prompt: prompt || t(`agentScene.rec.${id}`, options.values), skill: options.skill, urgent: options.urgent })
    }
    const failedProvider = data.providers.find((provider) => provider.lastTest && !provider.lastTest.ok)
    switch (key.value) {
      case 'providers':
      case 'setup':
        if (!data.providers.length) {
          add('connectDeepSeek', '', { skill: 'connect-provider' })
          add('connectOllama', '', { skill: 'connect-provider' })
        }
        if (failedProvider) add('providerFailed', '', { skill: 'connect-provider', urgent: true, values: { name: failedProvider.name } })
        break
      case 'bots':
        if (data.loadedBots && !data.bots.length) {
          add('connectQQ', '')
          add('tryDemo', '')
        }
        if (data.bots.some((item) => item.enabled && item.status === 'error')) add('botsFailing', '', { skill: 'diagnose-bot', urgent: true })
        break
      case 'botDetail':
        if (bot.value && bot.value.status !== 'online') add('botOffline', '', { skill: 'diagnose-bot', urgent: bot.value.enabled, values: { name: bot.value.name } })
        if (bot.value?.status === 'online' && !bot.value.plugins.some((plugin) => plugin.enabled)) {
          add('enableChat', '', { values: { name: bot.value.name } })
          add('flowTemplate', '', { skill: 'build-flow' })
        }
        if (bot.value?.status === 'online') add('botCommands', '')
        break
      case 'flows':
        if (counts.value.flows === 0) {
          add('flowCheckin', '', { skill: 'build-flow' })
          add('flowKeyword', '', { skill: 'build-flow' })
          add('flowService', '', { skill: 'build-flow' })
        } else {
          add('flowNew', '', { skill: 'build-flow' })
        }
        break
      case 'flowEditor': {
        const errors = Number(facts.value?.state?.errors ?? 0)
        if (errors) add('flowFix', '', { skill: 'fix-flow', urgent: true, values: { count: errors } })
        add('flowExplain', '')
        add('flowTests', '')
        break
      }
      case 'plugins':
        if (counts.value.failedPlugins?.length) add('pluginsFailed', '', { urgent: true, values: { names: counts.value.failedPlugins.join(', ') } })
        break
      default:
        break
    }
    if (!list.length) {
      add('connect', '')
      add('status', '')
      add('provider', '')
    }
    const hidden = new Set(profile.value.hidden ?? [])
    const custom = (profile.value.recommendations ?? []).map((item, index): Recommendation => ({
      id: `custom-${index}`, text: item.text, prompt: item.prompt?.trim() || item.text, skill: item.skill || undefined,
    }))
    return [...custom, ...list.filter((item) => !hidden.has(item.id))]
  })

  /** Skills recommended on this page by the user's profile, besides the skills' own scenes. */
  const skills = computed(() => profile.value.skills ?? [])

  /** The first urgent recommendation not yet dismissed on this page, for the bar above the input. */
  const banner = computed(() => (profile.value.autoShow === false
    ? undefined
    : recommendations.value.find((item) => item.urgent && !dismissed.value.has(`${path.value}|${item.id}`))))

  function dismiss(id: string) {
    dismissed.value = new Set([...dismissed.value, `${path.value}|${id}`])
  }

  /** The welcome line of an empty conversation, when the user set one for this page. */
  const welcome = computed(() => profile.value.welcome?.trim() || undefined)

  return { key, scene, recommendations, banner, welcome, skills, profiles, publish, dismiss, bind, refreshProfiles }
})
