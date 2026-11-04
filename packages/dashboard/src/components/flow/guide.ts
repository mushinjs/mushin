/**
 * The node list's hover tutorials: which node type is hovered and where, with a short delay so
 * sweeping the pointer over the list does not flash cards, and the example runs, fetched once.
 */
import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { call } from '../../api'
import type { NodeTypeInfo } from '../../types'

export interface GuidePass {
  input: { text: string; userName: string; userId: string; private: boolean; role?: string }
  matched: boolean
  steps: { nodeId: string; exec?: string; inputs?: Record<string, unknown>; outputs?: Record<string, unknown>; error?: string }[]
  replies: string[]
  error?: string
}

/** A node type's example after the server ran it; the first message's run is spread at the top. */
export interface GuideRun extends GuidePass {
  nodes: { id: string; type: string; config: Record<string, any>; inputs?: Record<string, string> }[]
  edges: ([string, string] | [string, string, string])[]
  /** Every message in order, the first included. */
  passes: GuidePass[]
  waits: string[]
}

const runs = new Map<string, Promise<GuideRun | null>>()

/** The example run of a node type; nothing when it has none. Failed fetches are tried again next time. */
export function guideRun(type: string) {
  let run = runs.get(type)
  if (!run) {
    run = call<GuideRun | null>('flows.guide', { type }).catch(() => {
      runs.delete(type)
      return null
    })
    runs.set(type, run)
  }
  return run
}

const SHOW_DELAY = 350
const HIDE_DELAY = 120

export function useGuideHover() {
  const hovered = shallowRef<NodeTypeInfo>()
  const anchor = ref<DOMRect>()
  let timer: ReturnType<typeof setTimeout> | undefined

  function enter(type: NodeTypeInfo, element: Element) {
    clearTimeout(timer)
    // Moving from one item to the next keeps the card open and switches it at once.
    const delay = hovered.value ? 0 : SHOW_DELAY
    timer = setTimeout(() => {
      anchor.value = element.getBoundingClientRect()
      hovered.value = type
    }, delay)
  }

  function leave() {
    clearTimeout(timer)
    timer = setTimeout(() => (hovered.value = undefined), HIDE_DELAY)
  }

  /** The pointer moved onto the card itself. */
  function keep() {
    clearTimeout(timer)
  }

  function hide() {
    clearTimeout(timer)
    hovered.value = undefined
  }

  onBeforeUnmount(() => clearTimeout(timer))
  return { hovered, anchor, enter, leave, keep, hide }
}
