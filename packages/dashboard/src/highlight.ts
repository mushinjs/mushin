import { nextTick, reactive } from 'vue'

export const highlightState = reactive({
  message: '',
  top: 0,
  left: 0,
  visible: false,
})

let hideTimer: number | undefined

function find(target: string) {
  return document.querySelector<HTMLElement>(`[data-fairy-target="${CSS.escape(target)}"]`)
}

function onScreen(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth && rect.width + rect.height > 0
}

/**
 * Pulses a control marked `data-fairy-target`, with an optional hint bubble. The page scrolls to it only with
 * `scroll`; otherwise a control off screen is left alone and the result says so, for the chat to offer it.
 */
export async function highlight(target: string, message?: string, options: { scroll?: boolean } = {}) {
  await nextTick()
  let element = find(target)
  for (let i = 0; !element && i < 15; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    element = find(target)
  }
  if (!element) return { ok: false, reason: `Nothing on this page is marked "${target}"` }
  if (!onScreen(element)) {
    if (!options.scroll) return { ok: true, offscreen: true, note: 'The control is off screen, so the page was left alone; the user can show it from the chat.' }
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  element.classList.remove('fairy-highlight')
  void element.offsetWidth
  element.classList.add('fairy-highlight')
  window.clearTimeout(hideTimer)
  await new Promise((resolve) => setTimeout(resolve, 350))
  const rect = element.getBoundingClientRect()
  highlightState.message = message ?? ''
  highlightState.top = rect.bottom + 8
  highlightState.left = Math.max(16, Math.min(rect.left, window.innerWidth - 296))
  highlightState.visible = !!message
  hideTimer = window.setTimeout(() => {
    element!.classList.remove('fairy-highlight')
    highlightState.visible = false
  }, 5000)
  return { ok: true }
}
