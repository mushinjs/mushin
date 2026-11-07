/**
 * A real message the editor works against: picked from a bot's recent chats, it shows which
 * triggers it starts and the values references get, feeds the prompt preview and can be run as a
 * test. Opening the editor with `?sample=<bot>:<channel>:<record id>` picks it right away.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { call } from '../../../api'
import { readPath, REF, refsIn, splitName } from '../../../flow'
import type { ChannelInfo, MessageRecord } from '../../../types'
import type { EditorState } from './state'

export interface Sample {
  bot: string
  /** The chat's id. */
  channel: string
  /** The message's record id. */
  id: string
}

export interface SampleMatch {
  message: { text: string; user: MessageRecord['user']; channel: ChannelInfo; at: number }
  role: 'master' | 'admin' | 'user'
  sys: Record<string, unknown>
  triggers: { nodeId: string; matched: boolean; reply?: string; outputs?: Record<string, unknown> }[]
}

export function useSample(s: EditorState) {
  const { route, realNodes, loaded, flowId } = s
  const sample = ref<Sample>()
  const match = ref<SampleMatch>()
  const matching = ref(false)
  const sampleError = ref('')

  function parseQuery(value: unknown): Sample | undefined {
    if (typeof value !== 'string') return
    const [bot, channel, ...rest] = value.split(':')
    const id = rest.join(':')
    return bot && channel && id ? { bot, channel, id } : undefined
  }
  watch(() => route.query.sample, (value) => {
    const picked = parseQuery(value)
    if (picked) sample.value = picked
  }, { immediate: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  watch(() => [sample.value, loaded.value, JSON.stringify(realNodes.value.map((node) => [node.id, node.data?.typeId, node.data?.config, node.data?.skip, node.data?.priority]))] as const, () => {
    clearTimeout(timer)
    if (!sample.value || !loaded.value) {
      match.value = undefined
      return
    }
    timer = setTimeout(refresh, 300)
  }, { immediate: true })
  onBeforeUnmount(() => clearTimeout(timer))

  async function refresh() {
    const picked = sample.value
    if (!picked) return
    matching.value = true
    try {
      const nodes = realNodes.value.map((node) => ({
        id: node.id,
        type: node.data!.typeId,
        config: node.data!.config,
        ...(node.data!.skip ? { skip: true } : {}),
        ...(node.data!.priority ? { priority: node.data!.priority } : {}),
      }))
      const result = await call<SampleMatch>('flows.sampleMatch', { id: flowId.value, sample: picked, nodes })
      if (sample.value === picked) {
        match.value = result
        sampleError.value = ''
      }
    } catch (error) {
      if (sample.value === picked) {
        match.value = undefined
        sampleError.value = (error as Error).message
      }
    } finally {
      matching.value = false
    }
  }

  function clearSample() {
    sample.value = undefined
    match.value = undefined
    sampleError.value = ''
  }

  const sampleTriggers = computed(() => new Map((match.value?.triggers ?? []).map((item) => [item.nodeId, item])))

  /**
   * What a binding reads for the sample, when it only refers to the message (`sys`) or to
   * triggers; nothing when it needs a node that only a run gives values to.
   */
  function sampleValue(binding: string | undefined) {
    if (!binding || !match.value) return
    const values = (head: string, name: string) => {
      const { first, path } = splitName(name)
      if (head === 'sys') return readPath(match.value!.sys[first], path)
      const trigger = sampleTriggers.value.get(head)
      return readPath(trigger?.outputs?.[first], path)
    }
    const refs = refsIn(binding)
    if (!refs.length) return
    let missing = false
    const text = binding.replace(REF, (_, head: string, name: string) => {
      const value = values(head, name)
      if (value === undefined) missing = true
      return value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
    })
    return missing ? undefined : text
  }

  /** The `sample` of a flows.test or flows.preview call. */
  const samplePayload = computed(() => (sample.value ? { bot: sample.value.bot, id: sample.value.id, channel: sample.value.channel } : undefined))

  return { sample, sampleMatch: match, matching, sampleError, clearSample, refreshSample: refresh, sampleTriggers, sampleValue, samplePayload }
}
