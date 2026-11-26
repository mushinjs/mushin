import { ref } from 'vue'
import type { Bot, FairyRef, FairyRefKind, FlowRunInfo, PluginRunInfo } from '../../types'

/** The drag data type of something that can be given to Fairy. */
export const REF_TYPE = 'application/x-mushin-ref'
/** Most attachments one message may carry; the server takes no more. */
export const MAX_REFS = 8
/** Most log lines one attachment carries; the newest are kept. */
export const MAX_LOG_LINES = 200

/** An attachment waiting in the input: what is sent, the label on its chip, and a line for its tooltip. */
export type PendingRef = FairyRef & { label: string; detail?: string }

export const REF_ICONS: Record<FairyRefKind, string> = {
  bot: 'i-lucide-bot',
  plugin: 'i-lucide-puzzle',
  flow: 'i-lucide-network',
  run: 'i-lucide-activity',
  log: 'i-lucide-scroll-text',
  chat: 'i-lucide-message-circle-more',
}

/** Two attachments of the same thing share a key, so it is attached once. */
export function refKey(item: FairyRef) {
  switch (item.kind) {
    case 'log': return `log:${item.lines.length}:${item.lines[0]}:${item.lines.at(-1)}`
    case 'chat': return `chat:${item.bot}:${item.id}`
    case 'run': return `run:${item.bot ?? ''}:${item.id}`
    default: return `${item.kind}:${item.id}`
  }
}

/** What goes to the server: the attachment without what only the chip shows. */
export function wireRef(item: PendingRef): FairyRef {
  const { detail, ...rest } = item
  return rest as FairyRef
}

const withDetail = (detail?: string) => (detail ? { detail } : {})

export const botRef = (bot: Pick<Bot, 'id' | 'name'>, detail?: string): PendingRef => ({ kind: 'bot', id: bot.id, label: bot.name, ...withDetail(detail) })
export const flowRef = (flow: { id: string; name: string; description?: string }): PendingRef => ({ kind: 'flow', id: flow.id, label: flow.name, ...withDetail(flow.description) })
export const pluginRef = (pkg: string, name: string, detail?: string): PendingRef => ({ kind: 'plugin', id: pkg, label: name, ...withDetail(detail) })
export const flowRunRef = (run: FlowRunInfo, detail?: string): PendingRef => ({ kind: 'run', id: run.id, label: run.flowName, ...withDetail(detail) })
export const pluginRunRef = (run: PluginRunInfo, name: string, detail?: string): PendingRef => ({ kind: 'run', id: run.id, bot: run.botId, at: run.startedAt, label: name, ...withDetail(detail) })

/** Log lines as they read in the viewer; the first one is the tooltip. */
export function logRef(lines: string[], label: string, source?: string): PendingRef {
  const kept = lines.slice(-MAX_LOG_LINES).map((line) => line.slice(0, 4000))
  return { kind: 'log', lines: kept, label, ...(source ? { source } : {}), ...withDetail(kept[0]) }
}

/** True while something that can go to Fairy is dragged, so inputs can show where it goes. */
export const draggingRef = ref(false)

function stopDragging() {
  draggingRef.value = false
}

/**
 * Starts dragging an attachment. The picture under the pointer is the chip it will become; the plain text
 * is its label, for anything else that takes a drop.
 */
export function startRefDrag(event: DragEvent, item: PendingRef) {
  const data = event.dataTransfer
  if (!data) return
  data.setData(REF_TYPE, JSON.stringify(item))
  data.setData('text/plain', item.label)
  data.effectAllowed = 'copy'
  const chip = document.createElement('div')
  chip.className = 'ref-drag-chip'
  const icon = document.createElement('span')
  icon.className = REF_ICONS[item.kind]
  chip.append(icon, document.createTextNode(item.label.length > 40 ? `${item.label.slice(0, 40)}…` : item.label))
  document.body.append(chip)
  data.setDragImage(chip, 14, 14)
  setTimeout(() => chip.remove())
  draggingRef.value = true
  // The row it started from can leave the page meanwhile (a virtual list), so the window hears the end.
  window.addEventListener('dragend', stopDragging, { once: true, capture: true })
  window.addEventListener('drop', stopDragging, { once: true, capture: true })
}

export const carriesRef = (event: DragEvent) => !!event.dataTransfer?.types.includes(REF_TYPE)

// A drag can start in another frame (a page in the workspace's panel): it shows here once it comes in.
// The pointer moves again only once a drag is over, wherever it ended.
if (typeof window !== 'undefined') {
  window.addEventListener('dragenter', (event) => {
    if (carriesRef(event)) draggingRef.value = true
  }, true)
  window.addEventListener('pointermove', () => {
    if (draggingRef.value) stopDragging()
  }, { passive: true })
}

/** What a page in the workspace's panel posts to the workspace: attach this to the conversation in focus. */
export const ATTACH_MESSAGE = 'mushin:fairy-attach'

/** True on a page shown in a frame, such as the workspace's panel. */
export const embedded = typeof window !== 'undefined' && window.self !== window.top

const KINDS = new Set<string>(Object.keys(REF_ICONS))

/** The attachment a drop carries, if it is one. */
export function droppedRef(event: DragEvent): PendingRef | undefined {
  const raw = event.dataTransfer?.getData(REF_TYPE)
  if (!raw) return undefined
  try {
    const item = JSON.parse(raw)
    return item && KINDS.has(item.kind) && typeof item.label === 'string' ? item as PendingRef : undefined
  } catch {
    return undefined
  }
}
