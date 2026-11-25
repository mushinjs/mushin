import { computed, ref } from 'vue'
import { call } from '../../api'
import type { Effort } from '../../stores/fairy'
import { useDataStore } from '../../stores/data'

interface Entry {
  id: string
  package: string
  config: Record<string, any>
}

const FAIRY = '@mushinjs/plugin-fairy'
const entry = ref<Entry>()
let loading: Promise<void> | undefined

/**
 * Fairy's own model settings, from its plugin's config: what the dock's "default" stands for, and where
 * "set as Fairy's default" saves to.
 */
export function useFairyDefaults() {
  const data = useDataStore()

  function load(force = false) {
    if (loading && !force) return loading
    loading = call<Entry[]>('plugins.list')
      .then((list) => {
        entry.value = list.find((plugin) => plugin.package === FAIRY)
      })
      .catch(() => {
        loading = undefined
      })
    return loading
  }

  /** The model the default stands for: Fairy's, else its provider's default, else the default provider's. */
  const model = computed<string | undefined>(() => {
    const config = entry.value?.config ?? {}
    if (config.model) return config.model
    const provider = config.provider ? data.providers.find((item) => item.id === config.provider) : data.providers.find((item) => item.isDefault)
    return provider?.defaultModel ?? data.profiles.find((item) => item.id === config.provider)?.name
  })
  const provider = computed<string | undefined>(() => entry.value?.config.provider)
  const effort = computed<Effort | undefined>(() => entry.value?.config.effort)

  async function save(choice: { provider?: string; model?: string; effort?: Effort }) {
    await load(true)
    const current = entry.value
    if (!current) throw new Error('Fairy is not installed')
    const config = { ...current.config, provider: choice.provider || undefined, model: choice.model || undefined, ...(choice.effort ? { effort: choice.effort } : {}) }
    await call('plugins.configure', { id: current.id, config })
    entry.value = { ...current, config }
  }

  return { load, model, provider, effort, save }
}
