import { defineStore } from 'pinia'
import { ref } from 'vue'
import { call, on } from '../api'
import type { AdapterType, Bot, BotStatusInfo, ModelProfile, Provider, ProviderType } from '../types'

/** Providers and bots, shared by pages and the Agent dock, kept fresh by server events. */
export const useDataStore = defineStore('data', () => {
  const providers = ref<Provider[]>([])
  const profiles = ref<ModelProfile[]>([])
  const providerTypes = ref<ProviderType[]>([])
  const ready = ref(false)
  const loadedProviders = ref(false)
  const bots = ref<Bot[]>([])
  const adapters = ref<AdapterType[]>([])
  const loadedBots = ref(false)

  async function refreshProviders() {
    const [list, types] = await Promise.all([
      call<{ providers: Provider[]; profiles?: ModelProfile[]; ready: boolean }>('providers.list'),
      call<ProviderType[]>('providers.types'),
    ])
    providers.value = list.providers
    profiles.value = list.profiles ?? []
    ready.value = list.ready
    providerTypes.value = types
    loadedProviders.value = true
  }

  async function refreshBots() {
    const [list, types] = await Promise.all([call<Bot[]>('bots.list'), call<AdapterType[]>('bots.adapters')])
    bots.value = list
    adapters.value = types
    loadedBots.value = true
  }

  function patchStatus(info: BotStatusInfo) {
    const bot = bots.value.find((item) => item.id === info.id)
    if (!bot) return
    bot.status = info.status
    bot.error = info.error
    bot.selfId = info.selfId
    bot.selfName = info.selfName
    bot.selfAvatar = info.selfAvatar
  }

  let bound = false
  function bind() {
    if (bound) return
    bound = true
    on('providers/changed', () => refreshProviders().catch(() => {}))
    on('bots/changed', () => refreshBots().catch(() => {}))
    on('bots/status', patchStatus)
    on('connected', () => {
      refreshProviders().catch(() => {})
      refreshBots().catch(() => {})
    })
  }

  return {
    providers, profiles, providerTypes, ready, loadedProviders, bots, adapters, loadedBots,
    refreshProviders, refreshBots, bind,
  }
})
