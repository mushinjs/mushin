import { WebSocket } from 'ws'
import { type ChannelInfo, type Context, field, type Segment, z } from '@mushinjs/core'
import { type Contact, mediaBytes, mediaSource } from '@mushinjs/plugin-bots'
import { DiscordApi } from './api'
import { buildContent, decodeMessage, DISCORD_SEGMENTS, type GuildInfo, guildInfo, memberRole } from './message'

export * from './api'
export * from './message'

export const name = 'adapter-discord'
export const inject = ['bots']

export const AdapterConfig = z.object({
  token: z.string().default('').meta(field(
    'Bot token',
    'From the Discord Developer Portal: your application → Bot → Reset Token',
    { 'zh-CN': { title: '机器人令牌', description: '在 Discord 开发者门户中：你的应用 → Bot → Reset Token' } },
  )),
  messageContent: z.boolean().default(true).meta(field(
    'Read message text',
    'Ask for the Message Content intent, without which Discord leaves the text out of messages that do not mention the bot. Turn it on under Bot → Privileged Gateway Intents too.',
    { 'zh-CN': { title: '读取消息内容', description: '申请 Message Content 意图；没有它，Discord 只会给出 @ 了机器人的消息内容。还需要在 Bot → Privileged Gateway Intents 中打开。' } },
  )),
  members: z.boolean().default(false).meta(field(
    'Member events',
    'Ask for the Server Members intent, for members joining and leaving. Turn it on in the Developer Portal too.',
    { 'zh-CN': { title: '成员事件', description: '申请 Server Members 意图，用于成员加入和离开事件。同样需要在开发者门户中打开。' } },
  )),
  endpoint: z.string().default('').meta(field('API address', 'Leave empty for https://discord.com/api/v10')),
})

export type AdapterConfig = z.infer<typeof AdapterConfig>

export const Intents = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
}

export function intentsOf(config: Pick<AdapterConfig, 'messageContent' | 'members'>) {
  let intents = Intents.GUILDS | Intents.GUILD_MESSAGES | Intents.GUILD_MESSAGE_REACTIONS | Intents.DIRECT_MESSAGES
  if (config.messageContent) intents |= Intents.MESSAGE_CONTENT
  if (config.members) intents |= Intents.GUILD_MEMBERS
  return intents
}

const RECONNECT_MIN = 1_000
const RECONNECT_MAX = 60_000

/** Close codes after which reconnecting cannot help. */
const FATAL_CLOSE: Record<number, string> = {
  4004: 'Discord refused the bot token; reset it in the Developer Portal and paste it again',
  4010: 'Discord refused the shard settings',
  4011: 'the bot is in too many servers for one connection',
  4012: 'Discord refused the gateway version',
  4013: 'Discord refused the intents',
  4014: 'the bot asked for a privileged intent it is not allowed; turn on Message Content (and Server Members, if used) under Bot → Privileged Gateway Intents, or turn the setting off here',
}

/** Close codes after which the session cannot be resumed. */
const NEW_SESSION = new Set([4007, 4009])

/** Text channel types: text, announcement, and the threads in them. */
const TEXT_CHANNELS = new Set([0, 5, 10, 11, 12])

class DiscordBot {
  private guilds = new Map<string, GuildInfo>()
  private channels = new Map<string, { name?: string; guild?: string; type?: number }>()
  /** DM channel ids, by user id. */
  private dms = new Map<string, string>()
  private logger

  constructor(private ctx: Context, public api: DiscordApi) {
    this.logger = ctx.logger('discord')
  }

  addGuild(guild: any) {
    if (!guild?.id) return
    this.guilds.set(String(guild.id), guildInfo(guild))
    for (const channel of [...guild.channels ?? [], ...guild.threads ?? []]) {
      this.channels.set(String(channel.id), { name: channel.name, guild: String(guild.id), type: channel.type })
    }
  }

  removeGuild(id: string) {
    this.guilds.delete(id)
    for (const [key, channel] of this.channels) if (channel.guild === id) this.channels.delete(key)
  }

  addChannel(channel: any) {
    if (channel?.id) this.channels.set(String(channel.id), { name: channel.name, guild: channel.guild_id ? String(channel.guild_id) : undefined, type: channel.type })
  }

  handleMessage(message: any) {
    if (String(message.author?.id) === this.ctx.bot.selfId) return
    const channel = this.channels.get(String(message.channel_id))
    const guild = message.guild_id ? this.guilds.get(String(message.guild_id)) : undefined
    const incoming = decodeMessage(message, { guild, channelName: channel?.name })
    if (!incoming) return
    if (!message.guild_id) this.dms.set(String(message.author.id), String(message.channel_id))
    this.ctx.bot.receive(incoming).catch((error) => this.logger.warn('failed to handle message: %s', error))
  }

  /** Non-message dispatches, named after Discord's event in lower case, e.g. `guild_member_add`. */
  handleEvent(type: string, data: any) {
    const userId = data?.user?.id ?? data?.user_id ?? data?.author?.id
    const channelId = data?.channel_id
    let channel: ChannelInfo | undefined
    if (channelId && data?.guild_id) channel = { type: 'group', id: String(channelId) }
    else if (channelId && userId) channel = { type: 'private', id: String(userId) }
    this.ctx.bot.dispatchEvent({
      type: 'discord',
      name: type.toLowerCase(),
      data,
      ...(channel ? { channel } : {}),
      ...(userId ? { user: { id: String(userId), ...(data.user?.username ? { name: data.user.global_name || data.user.username } : {}) } } : {}),
    })
  }

  private async dmChannel(userId: string) {
    const known = this.dms.get(userId)
    if (known) return known
    const channel = await this.api.request('POST', '/users/@me/channels', { recipient_id: userId })
    this.dms.set(userId, String(channel.id))
    return String(channel.id)
  }

  /**
   * Sends text (in pieces of up to 2000 characters), pictures from http addresses as embeds, and
   * everything else as uploaded files with the last piece of text.
   */
  async send(channel: ChannelInfo, segments: Segment[]) {
    const target = channel.type === 'group' ? channel.id : await this.dmChannel(channel.id)
    const replyId = segments.find((item) => item.type === 'reply')?.data.id
    const { chunks, everyone } = buildContent(segments)
    const embeds: any[] = []
    const files: { bytes: Buffer; name: string; mime: string }[] = []
    for (const segment of segments) {
      if (!['image', 'record', 'video', 'file'].includes(segment.type)) continue
      const source = await mediaSource(segment)
      if (source.kind === 'url' && segment.type === 'image' && embeds.length < 10) embeds.push({ image: { url: source.url } })
      else files.push(await mediaBytes(segment))
    }
    const allowed = { parse: everyone ? ['users', 'everyone'] : ['users'], replied_user: true }
    const ids: string[] = []
    const pieces = chunks.length ? chunks : ['']
    for (const [index, content] of pieces.entries()) {
      const last = index === pieces.length - 1
      const body: Record<string, any> = {
        ...(content ? { content } : {}),
        allowed_mentions: allowed,
        ...(index === 0 && replyId ? { message_reference: { message_id: String(replyId), fail_if_not_exists: false } } : {}),
        ...(last && embeds.length ? { embeds } : {}),
      }
      if (last && files.length) {
        const form = new FormData()
        body.attachments = files.slice(0, 10).map((file, id) => ({ id, filename: file.name }))
        form.set('payload_json', JSON.stringify(body))
        files.slice(0, 10).forEach((file, id) => form.set(`files[${id}]`, new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name))
        const sent = await this.api.request('POST', `/channels/${target}/messages`, form)
        ids.push(String(sent.id))
      } else if (content || body.embeds) {
        const sent = await this.api.request('POST', `/channels/${target}/messages`, body)
        ids.push(String(sent.id))
      }
    }
    return { messageId: ids[0] }
  }

  /** Text channels of every server the bot is in, as groups. */
  contacts(): Contact[] {
    return [...this.channels.entries()]
      .filter(([, channel]) => channel.guild && TEXT_CHANNELS.has(channel.type ?? 0))
      .map(([id, channel]) => {
        const guild = this.guilds.get(channel.guild!)
        return { type: 'group', id, name: `#${channel.name ?? id}${guild?.name ? ` (${guild.name})` : ''}` }
      })
  }

  /** A member's role in the server a channel belongs to. */
  async roleOf(channelId: string, userId: string) {
    const guildId = this.channels.get(channelId)?.guild
    const guild = guildId ? this.guilds.get(guildId) : undefined
    if (!guild) return
    if (guild.ownerId === userId) return 'owner' as const
    const member = await this.api.request('GET', `/guilds/${guild.id}/members/${userId}`)
    return memberRole(guild, userId, member?.roles)
  }
}

/** The gateway: identify, heartbeat (reconnecting when Discord stops acknowledging), resume after drops. */
function startGateway(ctx: Context, config: AdapterConfig, bot: DiscordBot) {
  const logger = ctx.logger('discord')
  let socket: WebSocket | undefined
  let heartbeat: NodeJS.Timeout | undefined
  let retryTimer: NodeJS.Timeout | undefined
  let delay = RECONNECT_MIN
  let stopped = false
  let seq: number | null = null
  let session: { id: string; url: string } | undefined

  const scheduleReconnect = (wait = delay) => {
    if (stopped || retryTimer) return
    logger.info('reconnecting in %ds', Math.round(wait / 1000))
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      connect().catch(() => {})
    }, wait)
    delay = Math.min(delay * 2, RECONNECT_MAX)
  }

  const connect = async () => {
    if (ctx.bot.status !== 'error') ctx.bot.setStatus('connecting')
    let base = session?.url
    if (!base) {
      try {
        base = (await bot.api.request<{ url: string }>('GET', '/gateway/bot')).url
      } catch (error: any) {
        if (stopped) return
        const fatal = error.status === 401
        logger.warn('cannot get the gateway address: %s', error.message)
        ctx.bot.setStatus('error', fatal ? FATAL_CLOSE[4004] : `Cannot reach Discord: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`)
        if (!fatal) scheduleReconnect()
        return
      }
    }
    if (stopped) return
    const address = new URL(base!)
    address.searchParams.set('v', '10')
    address.searchParams.set('encoding', 'json')
    const url = address.href
    logger.info('connecting to %s', url)
    const current = socket = new WebSocket(url)
    let acknowledged = true
    const send = (payload: unknown) => current.readyState === WebSocket.OPEN && current.send(JSON.stringify(payload))
    const beat = () => {
      if (!acknowledged) {
        logger.warn('Discord did not acknowledge the last heartbeat, reconnecting')
        return current.close(4000, 'heartbeat not acknowledged')
      }
      acknowledged = false
      send({ op: 1, d: seq })
    }

    current.on('message', (raw) => {
      let payload: any
      try {
        payload = JSON.parse(raw.toString())
      } catch {
        return logger.warn('received a non-JSON frame')
      }
      if (typeof payload.s === 'number') seq = payload.s
      switch (payload.op) {
        case 10: {
          const interval = Number(payload.d?.heartbeat_interval) || 41_250
          clearInterval(heartbeat)
          // The first beat comes after a random part of the interval, as Discord asks.
          setTimeout(() => {
            if (current !== socket || current.readyState !== WebSocket.OPEN) return
            beat()
            heartbeat = setInterval(beat, interval)
          }, Math.floor(interval * Math.random()))
          if (session) {
            logger.info('resuming session %s', session.id)
            send({ op: 6, d: { token: config.token, session_id: session.id, seq } })
          } else {
            send({ op: 2, d: { token: config.token, intents: intentsOf(config), properties: { os: process.platform, browser: 'mushin', device: 'mushin' } } })
          }
          return
        }
        case 11:
          acknowledged = true
          return
        case 1:
          return send({ op: 1, d: seq })
        case 7:
          logger.info('Discord asked to reconnect')
          return current.close(4000, 'reconnect')
        case 9:
          logger.info('the session is no longer valid%s', payload.d ? ', resuming' : ', starting a new one')
          if (!payload.d) {
            session = undefined
            seq = null
          }
          return current.close(4000, 'invalid session')
        case 0:
          return dispatch(String(payload.t), payload.d)
      }
    })

    const dispatch = (type: string, d: any) => {
      switch (type) {
        case 'READY': {
          session = { id: String(d.session_id), url: String(d.resume_gateway_url || base) }
          delay = RECONNECT_MIN
          const user = d.user ?? {}
          const name = user.global_name || user.username
          ctx.bot.setSelf(String(user.id), name, user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : undefined)
          logger.info('logged in as %s (%s), in %d server(s)', name, user.id, d.guilds?.length ?? 0)
          ctx.bot.setStatus('online')
          return
        }
        case 'RESUMED':
          delay = RECONNECT_MIN
          logger.info('session resumed')
          ctx.bot.setStatus('online')
          return
        case 'GUILD_CREATE':
        case 'GUILD_UPDATE':
          // An update carries the guild's roles but not its channels; the known channels stay.
          return bot.addGuild(d)
        case 'GUILD_DELETE':
          if (!d?.unavailable) bot.removeGuild(String(d?.id))
          return
        case 'CHANNEL_CREATE':
        case 'CHANNEL_UPDATE':
        case 'THREAD_CREATE':
        case 'THREAD_UPDATE':
          return bot.addChannel(d)
        case 'MESSAGE_CREATE':
          return bot.handleMessage(d)
        default:
          return bot.handleEvent(type, d)
      }
    }

    current.on('error', (error) => {
      if (!stopped) logger.warn('gateway error: %s', error.message)
    })
    current.on('close', (code, reason) => {
      clearInterval(heartbeat)
      if (stopped || current !== socket) return
      const text = reason.toString()
      logger.info('gateway closed (code %d%s)', code, text ? `, ${text}` : '')
      if (FATAL_CLOSE[code]) {
        ctx.bot.setStatus('error', `Discord closed the connection: ${FATAL_CLOSE[code]} (code ${code})`)
        return
      }
      if (NEW_SESSION.has(code)) {
        session = undefined
        seq = null
      }
      if (ctx.bot.status === 'online') ctx.bot.setStatus('connecting')
      scheduleReconnect()
    })
  }

  connect().catch(() => {})
  ctx.effect(() => () => {
    stopped = true
    clearTimeout(retryTimer)
    clearInterval(heartbeat)
    socket?.close(1000, 'bot stopped')
  }, 'discord gateway connection')
}

const Connection = {
  name: 'discord',
  inject: ['bot'],
  Config: AdapterConfig,
  apply(ctx: Context, config: AdapterConfig) {
    const api = new DiscordApi(config.token, config.endpoint)
    const bot = new DiscordBot(ctx, api)
    startGateway(ctx, config, bot)
    ctx.bot.useTransport({
      send: (channel, segments) => bot.send(channel, segments),
      call: (action, params) => {
        // `GET /users/@me`, `POST /channels/{id}/messages`… as "METHOD /path".
        const [method, path] = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/i.exec(action)?.slice(1) ?? []
        if (!method) throw new Error('Discord API calls are written as "METHOD /path", e.g. "GET /users/@me"')
        return api.request(method.toUpperCase(), path, method.toUpperCase() === 'GET' ? undefined : params)
      },
    })
    ctx.bot.useRoleResolver(({ channel, user }) => bot.roleOf(channel.id, user.id))
    ctx.bot.useContacts(async () => bot.contacts())
  },
}

export function apply(ctx: Context) {
  ctx.bots.defineAdapter({
    id: 'discord',
    displayName: 'Discord',
    config: AdapterConfig,
    secrets: ['token'],
    segments: DISCORD_SEGMENTS,
    groupRoles: true,
    hiddenFields: { '*': ['endpoint'] },
    plugin: Connection,
    describe: () => ({ mode: 'ws', address: 'gateway.discord.gg' }),
  })
}
