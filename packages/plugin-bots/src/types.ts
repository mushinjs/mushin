import type { ChannelInfo, LocalizedText, Plugin, Provenance, Segment, z } from '@mushin/core'

export type BotStatus = 'offline' | 'connecting' | 'online' | 'error'

export interface BotPluginEntry {
  package: string
  enabled: boolean
  config: Record<string, any>
}

export interface BotRecord {
  id: string
  name: string
  enabled: boolean
  adapter: { type: string; config: Record<string, any> }
  plugins: BotPluginEntry[]
  /** Default provider id for this bot's LLM plugins. */
  provider?: string
  createdAt: number
}

/** How an adapter delivers outgoing messages and raw API calls for one bot. */
export interface Transport {
  send(channel: ChannelInfo, segments: Segment[]): Promise<{ messageId?: string }>
  call?(action: string, params: Record<string, any>): Promise<any>
}

export interface AdapterType<C = any> {
  id: string
  displayName: LocalizedText
  config: z.ZodType<C>
  /** Config keys holding secrets; masked in API responses. */
  secrets?: string[]
  /** Segment types this adapter can send; used to compute a message's supported platforms. */
  segments: string[]
  /**
   * Loaded inside each bot's isolated context with the bot's adapter config.
   * It injects `bot`, opens the connection and registers a transport.
   */
  plugin: Plugin
}

export interface IncomingMessage {
  messageId?: string
  channel: ChannelInfo
  user: { id: string; name?: string }
  segments: Segment[]
  timestamp?: number
}

/** Content plus an explicit source, e.g. an LLM result (`{ text, source }`). */
export interface SourcedContent {
  text?: string
  segments?: Segment[]
  source?: Provenance
}

export interface BotEvent {
  type: string
  data: any
}
