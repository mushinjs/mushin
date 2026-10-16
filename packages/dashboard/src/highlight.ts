import { nextTick, reactive } from 'vue'

export const highlightState = reactive({
  message: '',
  top: 0,
  left: 0,
  visible: false,
})

let hideTimer: number | undefined

function find(target: string) {
  return document.querySelector<HTMLElement>(`[data-agent-target="${CSS.escape(target)}"]`)
}

/** Scrolls to a control marked `data-agent-target` and pulses it, with an optional hint bubble. */
export async function highlight(target: string, message?: string) {
  await nextTick()
  let element = find(target)
  for (let i = 0; !element && i < 15; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    element = find(target)
  }
  if (!element) return { ok: false, reason: `Nothing on this page is marked "${target}"` }
  element.scrollIntoView({ block: 'center', behavior: 'smooth' })
  element.classList.remove('agent-highlight')
  void element.offsetWidth
  element.classList.add('agent-highlight')
  window.clearTimeout(hideTimer)
  await new Promise((resolve) => setTimeout(resolve, 350))
  const rect = element.getBoundingClientRect()
  highlightState.message = message ?? ''
  highlightState.top = rect.bottom + 8
  highlightState.left = Math.max(16, Math.min(rect.left, window.innerWidth - 296))
  highlightState.visible = !!message
  hideTimer = window.setTimeout(() => {
    element!.classList.remove('agent-highlight')
    highlightState.visible = false
  }, 5000)
  return { ok: true }
}
