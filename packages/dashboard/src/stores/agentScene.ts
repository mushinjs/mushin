import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { call } from '../api'
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

/** Facts a page knows better than the route, such as the open flow's name and error count. */
export interface PageFacts {
  label?: string
  state?: Record<string, string | number | boolean>
  resource?: string
}

const t = (key: string, values: Record<string, unknown> = {}) => i18n.global.t(key, values)

/** Scene kind of a dashboard path. */
export function sceneKey(path: string) {
  const [, first, id] = path.split('/')
  if (first === 'bots') return id ? 'botDetail' : 'bots'
  if (first === 'flows') return id ? 'flowEditor' : 'flows'
  return ['overview', 'setup', 'providers', 'personas', 'plugins', 'logs', 'agent'].includes(first) ? first : 'overview'
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
    return { key: key.value, label, hint: t(`agentScene.hint.${key.value}`), ...(Object.keys(state).length ? { state } : {}), ...(resource ? { resource } : {}) }
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
    return list
  })

  /** The first urgent recommendation not yet dismissed on this page, for the bar above the input. */
  const banner = computed(() => recommendations.value.find((item) => item.urgent && !dismissed.value.has(`${path.value}|${item.id}`)))

  function dismiss(id: string) {
    dismissed.value = new Set([...dismissed.value, `${path.value}|${id}`])
  }

  return { key, scene, recommendations, banner, publish, dismiss }
})
