import { reactive, type VNodeChild } from 'vue'

/**
 * Toasts and confirmation dialogs. The calls take the shapes of Naive UI's `useMessage()` and
 * `useDialog()`, so `message.success('Saved')` and
 * `dialog.warning({ title, content, positiveText, onPositiveClick })` keep working after the
 * import changes. UiProvider draws them; the state is shared, so the calls work outside setup too.
 */

export type ToastType = 'info' | 'success' | 'warning' | 'error' | 'loading'

export interface ToastOptions {
  /** How long it stays, in milliseconds; 0 keeps it until destroyed. */
  duration?: number
  closable?: boolean
}

export interface Toast {
  id: number
  type: ToastType
  content: string
  duration: number
  closable: boolean
}

export interface ToastHandle {
  destroy: () => void
  /** Changes the text, e.g. a loading toast that finishes. */
  update: (content: string, type?: ToastType) => void
}

export interface ConfirmOptions {
  title?: string
  /** Text, or a render function for richer content such as a list. */
  content?: string | (() => VNodeChild)
  positiveText?: string
  negativeText?: string
  /** Return false (or a promise of false) to keep the dialog open. */
  onPositiveClick?: () => unknown
  onNegativeClick?: () => unknown
  onClose?: () => unknown
  /** Clicking outside closes it as if cancelled; on by default. */
  maskClosable?: boolean
  /** Called when a click outside closes it, before onNegativeClick. */
  onMaskClick?: () => unknown
}

export interface Confirm extends ConfirmOptions {
  id: number
  type: 'info' | 'success' | 'warning' | 'error'
  loading: boolean
}

export const feedback = reactive({ toasts: [] as Toast[], confirms: [] as Confirm[] })

let next = 1

function toast(type: ToastType, content: string, options: ToastOptions = {}): ToastHandle {
  const id = next++
  const duration = options.duration ?? (type === 'loading' ? 0 : type === 'error' ? 5000 : 3000)
  feedback.toasts.push({ id, type, content, duration, closable: options.closable ?? type === 'error' })
  const destroy = () => {
    const index = feedback.toasts.findIndex((item) => item.id === id)
    if (index >= 0) feedback.toasts.splice(index, 1)
  }
  if (duration > 0) setTimeout(destroy, duration)
  return {
    destroy,
    update(content, nextType) {
      const item = feedback.toasts.find((entry) => entry.id === id)
      if (!item) return
      item.content = content
      if (nextType) item.type = nextType
      if (nextType && nextType !== 'loading') setTimeout(destroy, 3000)
    },
  }
}

const toastApi = {
  info: (content: string, options?: ToastOptions) => toast('info', content, options),
  success: (content: string, options?: ToastOptions) => toast('success', content, options),
  warning: (content: string, options?: ToastOptions) => toast('warning', content, options),
  error: (content: string, options?: ToastOptions) => toast('error', content, options),
  loading: (content: string, options?: ToastOptions) => toast('loading', content, options),
  destroyAll: () => feedback.toasts.splice(0),
}

export type ToastApi = typeof toastApi

/** Short notes at the top of the screen: `useToast().success('Saved')`. */
export function useToast(): ToastApi {
  return toastApi
}

function confirm(type: Confirm['type'], options: ConfirmOptions) {
  const id = next++
  feedback.confirms.push({ ...options, id, type, loading: false })
  return {
    destroy: () => {
      const index = feedback.confirms.findIndex((item) => item.id === id)
      if (index >= 0) feedback.confirms.splice(index, 1)
    },
  }
}

const confirmApi = {
  info: (options: ConfirmOptions) => confirm('info', options),
  success: (options: ConfirmOptions) => confirm('success', options),
  warning: (options: ConfirmOptions) => confirm('warning', options),
  error: (options: ConfirmOptions) => confirm('error', options),
  create: (options: ConfirmOptions) => confirm('info', options),
  destroyAll: () => feedback.confirms.splice(0),
}

export type ConfirmApi = typeof confirmApi

/** A dialog that asks before something happens: `useConfirm().warning({ title, content, onPositiveClick })`. */
export function useConfirm(): ConfirmApi {
  return confirmApi
}
