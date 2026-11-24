import type { CommandSettings } from './commands'
import type { ChannelInfo, LocalizedText, Plugin, Provenance, Segment, UserInfo, z } from '@mushinjs/core'

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
  /**
   * App plugins (by package) whose chat commands this bot answers. A command an app plugin adds with
   * `bots.defineCommand` is off on a bot until it is turned on here, unless the plugin picks the bots itself.
   */
  appPlugins?: string[]
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
  /** One short line on what the adapter connects to, for the adapter picker. */
  description?: LocalizedText
  /**
   * The platform's logo as the inside of a 24×24 SVG (paths using `currentColor`), shown in the
   * adapter picker and behind bot cards. Drawn as a mask, so it never runs as markup.
   */
  icon?: string
  /** The platform's brand colour, for the icon. */
  color?: string
  config: z.ZodType<C>
  /** Config keys holding secrets. They are kept in .env (the config holds `${NAME}` references), resolved before the adapter starts, and masked in API responses. */
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
   * Addresses of people's and groups' pictures, with `{id}` standing for the user or group id,
   * for the dashboard's live conversation view. Left out when the platform has no such addresses.
   */
  avatars?: { user?: string; group?: string }
  /**
   * Config fields the dashboard leaves out, by the value of the config's `mode` field (its schema
   * default when unset); `*` lists fields hidden in every mode, such as API addresses for tests.
   */
  hiddenFields?: Record<string, string[]>
  /** Pages that help set a bot up, such as the platform's developer portal, shown as buttons by the form. */
  links?: { url: string; label: LocalizedText }[]
  /**
   * Creating or binding a bot by scanning a QR code, through two actions the adapter defines:
   * `start` answers `{ id, qrcode, interval }` (seconds between polls), where `qrcode` is the text
   * to draw as a QR code; `poll` takes `{ id }` and answers `{ status }`, one of `pending`, `created`
   * (with the adapter `config` to fill in), `expired` or `error` (with a `message`).
   */
  qrSetup?: { start: string; poll: string }
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

/** A file a message points at, as an address the dashboard can open. */
export interface ResolvedMedia {
  /** An http(s) address, or a `data:` URL when the bytes were fetched for showing in place. */
  url: string
  name?: string
  size?: number
}

/** One message of a forwarded chat history. */
export interface ForwardedMessage {
  user: UserInfo
  timestamp: number
  segments: Segment[]
}

/**
 * Fetches what a message only points at: images, videos and files (whose addresses in the message
 * can expire) and the messages of a forwarded chat history. Registered per bot by adapters.
 */
export interface MediaResolver {
  /** `inline`: return the bytes as a data URL, for showing an image in place. */
  media?(segment: Segment, options: { channel?: ChannelInfo; inline: boolean }): Promise<ResolvedMedia | undefined>
  forward?(id: string): Promise<ForwardedMessage[]>
}

/** A friend or group the bot's account has, from the platform. */
export interface Contact extends ChannelInfo {
  /** The name the account gave a friend, when it differs from the friend's own. */
  remark?: string
  /** How many members a group has. */
  members?: number
}

/** Lists the account's friends and groups; registered per bot by adapters that can. */
export type ContactResolver = () => Promise<Contact[]>

/**
 * The sandbox conversation every bot has in the live view: the dashboard plays a test user in a
 * private chat, the bot answers through its flows and plugins, and nothing reaches the platform.
 */
export const SANDBOX_CHANNEL: ChannelInfo = { type: 'private', id: '@sandbox', name: 'Sandbox' }
export const SANDBOX_USER = { id: '@sandbox', name: 'Sandbox tester' }

export const isSandbox = (channel: { id: string } | undefined) => channel?.id === SANDBOX_CHANNEL.id

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

/**
 * A message a plugin handled on a bot, for the bot's runs beside the flow runs: it replied, kept the
 * message from the plugins after it, or failed. Plugins that only looked at the message leave no run.
 */
export interface PluginRun {
  id: string
  botId: string
  /** The plugin's package, or its name when the package is not known. */
  plugin: string
  /** The command the plugin answered, such as `天气`. */
  command?: string
  /** The message, cut to 200 characters. */
  text: string
  user: UserInfo
  /** `group:123` or `private:456`. */
  channel: string
  /** The bot's record of the message (its `MessageRecord` id). */
  message: string
  status: 'ok' | 'error'
  /** Messages the plugin sent while handling it. */
  replies: number
  /** The plugin did not pass the message on to the plugins after it. */
  kept: boolean
  startedAt: number
  /** Time spent in the plugin itself, not in the plugins after it. */
  ms: number
  error?: string
}
