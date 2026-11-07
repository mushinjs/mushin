import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * One cost a message caused: a model request (a reply, reading an image, a decision, an
 * embedding), or a plugin's own work such as speech or image generation.
 */
export interface UsageEvent {
  /** `chat`, `vision`, `decision`, `embed`, or a plugin's own kind such as `tts` or `image`. */
  kind: string
  /** The plugin that asked for it. */
  plugin?: string
  provider?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  latencyMs?: number
  /** Bytes moved, for transfers. */
  bytes?: number
  ok?: boolean
  /** A short note from the plugin, such as "2 images". */
  note?: string
  at: number
}

/** The message whose handling is running; costs reported meanwhile are counted against it. */
export interface UsageScope {
  botId: string
  messageId: string
  report(event: UsageEvent): void
}

const storage = new AsyncLocalStorage<UsageScope>()

/**
 * Per-message usage. A bot runs a message's middleware inside `usage.run`, so model requests and
 * plugin work started while handling it, however deep and however late, land on that message.
 */
export const usage = {
  run<T>(scope: UsageScope, fn: () => T): T {
    return storage.run(scope, fn)
  },
  current(): UsageScope | undefined {
    return storage.getStore()
  },
  /** Counts a cost against the message being handled; does nothing outside one. */
  report(event: Omit<UsageEvent, 'at'> & { at?: number }) {
    storage.getStore()?.report({ ...event, at: event.at ?? Date.now() })
  },
}
