import type { CommandSettings } from './commands'
import type { ChannelInfo, LocalizedText, Plugin, Provenance, Segment, UserInfo, z } from '@mushin/core'

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
  /** Command prefixes, the built-in `/help` and admins. */
  commands?: CommandSettings
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
  /** The adapter can tell a sender's group role (owner, admin, member); its bots call `bot.useRoleResolver()`. */
  groupRoles?: boolean
  /**
   * How a bot with this config connects, for the bots list: a mode such as `ws`, `ws-reverse` or
   * `http`, the address it dials or is reached at, and for HTTP the path events are posted to.
   */
  describe?(config: C, botId: string): BotConnectionInfo
  /**
   * Loaded inside each bot's isolated context with the bot's adapter config.
   * It injects `bot`, opens the connection and registers a transport.
   */
  plugin: Plugin
}

export interface BotConnectionInfo {
  mode: string
  address?: string
  inbound?: string
}

export interface IncomingMessage {
  messageId?: string
  channel: ChannelInfo
  user: UserInfo
  segments: Segment[]
  timestamp?: number
}

/**
 * A sender's role on one bot, from the permissions plugin: `master` owns the bot, `admin` helps
 * manage it, `user` is everyone else. Higher roles include lower ones.
 */
export type BotRole = 'master' | 'admin' | 'user'

/** A sender's role in a group, as the platform reports it. Kept apart from bot roles. */
export type GroupRole = 'owner' | 'admin' | 'member'

export const ROLE_RANK: Record<BotRole, number> = { user: 0, admin: 1, master: 2 }

/** Whether `role` meets `required`: a master passes where an admin is required. */
export function roleAtLeast(role: BotRole | undefined, required: BotRole) {
  return role !== undefined && ROLE_RANK[role] >= ROLE_RANK[required]
}

/** Who someone is to a bot; supplied by the permissions plugin through `bots.usePermissions()`. */
export interface PermissionProvider {
  roleOf(botId: string, userId: string): BotRole
}

/** Asks the platform for a sender's group role; registered per bot by adapters that can tell. */
export type GroupRoleResolver = (target: { channel: ChannelInfo; user: UserInfo }) => Promise<GroupRole | undefined>

/** Content plus an explicit source, e.g. an LLM result (`{ text, source }`). */
export interface SourcedContent {
  text?: string
  segments?: Segment[]
  source?: Provenance
}

/** A non-message event from an adapter, such as a notice or a request. */
export interface BotEvent {
  /** The adapter's event family, e.g. OneBot's `notice` or `request`. */
  type: string
  /** The event as the platform sent it. */
  data: any
  /** A normalized name such as `group_increase` or `notify.poke`; flows only see events that have one. */
  name?: string
  /** Where the event happened, so flows can reply there. */
  channel?: ChannelInfo
  /** Who the event is about. */
  user?: UserInfo
  /** The message the event is about, when it is known (e.g. the text of a recalled message). */
  message?: { id?: string; text: string; segments: Segment[] }
}
