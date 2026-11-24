import { createDecipheriv } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { WebSocket } from 'ws'
import { type ChannelInfo, type Context, field, type Segment, z } from '@mushinjs/core'
import { type Contact, type GroupRole, mediaBytes, mediaSource } from '@mushinjs/plugin-bots'
import type {} from '@cordisjs/plugin-server'
import { KookApi, KookError } from './api'
import { buildContent, decodeEvent, decodeMessage, KOOK_SEGMENTS, MessageType } from './message'

export * from './api'
export * from './message'

export const name = 'adapter-kook'
export const inject = ['bots']

export const AdapterConfig = z.object({
  mode: z.enum(['websocket', 'webhook']).default('websocket').meta(field(
    'Connection mode',
    'websocket: Mushin connects to KOOK; works without a public address. webhook: KOOK posts events to Mushin, which needs a public address.',
    { 'zh-CN': { title: '接入方式', description: 'websocket：Mushin 连接 KOOK，不需要公网地址。webhook：KOOK 把事件推送到 Mushin，需要公网地址。' } },
  )),
  token: z.string().default('').meta(field(
    'Bot token',
    'From the KOOK developer center (developer.kookapp.cn): Applications → your bot → Bot → Token',
    { 'zh-CN': { title: '机器人 Token', description: '在 KOOK 开发者中心（developer.kookapp.cn）：应用 → 你的机器人 → 机器人 → Token' } },
  )),
  verifyToken: z.string().default('').meta(field(
    'Verify token',
    'webhook mode: the Verify Token shown on the bot\'s page; events carrying another one are refused',
    { 'zh-CN': { title: 'Verify Token', description: 'webhook 模式：机器人页面上的 Verify Token；不一致的事件会被拒绝' } },
  )),
  encryptKey: z.string().default('').meta(field(
    'Encrypt key',
    'webhook mode: the Encrypt Key, when message encryption is on',
    { 'zh-CN': { title: '消息加密密钥', description: 'webhook 模式：开启消息加密时的 Encrypt Key' } },
  )),
  path: z.string().regex(/^(\/[\w.~-]*)*$/, 'must be a path such as /kook/mybot').default('').meta(field(
    'Webhook path',
    'Path KOOK posts events to; empty means /kook/<bot id>. Set the Callback URL on the bot\'s page to http(s)://<your address><path>.',
    { 'zh-CN': { title: 'Webhook 路径', description: 'KOOK 推送事件的路径；留空则为 /kook/<机器人 id>。在机器人页面把 Callback URL 设为 http(s)://<你的地址><路径>。' } },
  )),
  endpoint: z.string().default('').meta(field('API address', 'Leave empty for https://www.kookapp.cn/api/v3')),
})

export type AdapterConfig = z.infer<typeof AdapterConfig>

const PING_INTERVAL = 30_000
const PONG_TIMEOUT = 6_000
const HELLO_TIMEOUT = 6_000
const RECONNECT_MIN = 1_000
const RECONNECT_MAX = 60_000
const LOGIN_RETRY = 30_000
const ROLE_CACHE_MS = 5 * 60_000
/** Hello codes for a token problem, which reconnecting does not fix. */
const TOKEN_CODES = new Set([40101, 40102])
const ADMINISTRATOR = 1

/** Where KOOK posts events in webhook mode. */
const inboundPath = (config: AdapterConfig, botId: string) => config.path || `/kook/${botId}`

/**
 * Decrypts an encrypted webhook body: base64 of a 16-character IV followed by base64 of the
 * AES-256-CBC ciphertext, keyed with the Encrypt Key padded with NUL bytes to 32.
 */
export function decryptWebhook(encrypted: string, key: string) {
  const decoded = Buffer.from(encrypted, 'base64').toString('utf8')
  const iv = Buffer.from(decoded.slice(0, 16), 'utf8')
  const cipher = Buffer.from(decoded.slice(16), 'base64')
  const keyBytes = Buffer.alloc(32)
  Buffer.from(key, 'utf8').copy(keyBytes)
  const decipher = createDecipheriv('aes-256-cbc', keyBytes, iv)
  return Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8')
}

/** A webhook body as JSON: KOOK deflates it unless the callback address says `compress=0`. */
export function readWebhookBody(bytes: Buffer, encryptKey: string) {
  let text: string
  try {
    text = bytes[0] === 0x7b ? bytes.toString('utf8') : inflateSync(bytes).toString('utf8')
  } catch {
    text = bytes.toString('utf8')
  }
  let payload = JSON.parse(text)
  if (typeof payload?.encrypt === 'string') {
    if (!encryptKey) throw new Error('the event is encrypted; set the Encrypt Key')
    payload = JSON.parse(decryptWebhook(payload.encrypt, encryptKey))
  }
  return payload
}

class KookBot {
  /** Each channel's guild, from messages, for roles. */
  private channelGuilds = new Map<string, string>()
  private guilds = new Map<string, { owner?: string; adminRoles: Set<number>; at: number }>()
  private roles = new Map<string, { role: GroupRole | undefined; at: number }>()
  private lastSn = 0
  private logger

  constructor(private ctx: Context, public api: KookApi) {
    this.logger = ctx.logger('kook')
  }

  async login() {
    const me = await this.api.request('GET', '/user/me')
    this.ctx.bot.setSelf(String(me.id), me.nickname || me.username, me.avatar || undefined)
    this.logger.info('logged in as %s (%s)', me.username, me.id)
  }

  /** Resets the event order, for a new WebSocket session. */
  resetSn() {
    this.lastSn = 0
  }

  get sn() {
    return this.lastSn
  }

  /** Handles one event; KOOK may send an event again after a resume, so seen numbers are skipped. */
  handle(d: any, sn?: number) {
    if (typeof sn === 'number') {
      if (sn <= this.lastSn) return
      this.lastSn = sn
    }
    if (d?.extra?.guild_id && d.channel_type === 'GROUP') this.channelGuilds.set(String(d.target_id), String(d.extra.guild_id))
    if (d?.type === MessageType.system) {
      const event = decodeEvent(d)
      if (event) this.ctx.bot.dispatchEvent(event)
      return
    }
    if (String(d?.author_id) === this.ctx.bot.selfId) return
    const message = decodeMessage(d)
    if (message) this.ctx.bot.receive(message).catch((error) => this.logger.warn('failed to handle message: %s', error))
  }

  /** Text first (with a quote when replying), then each picture, video, voice or file uploaded to KOOK. */
  async send(channel: ChannelInfo, segments: Segment[]) {
    const path = channel.type === 'group' ? '/message/create' : '/direct-message/create'
    const quote = segments.find((item) => item.type === 'reply')?.data.id
    const ids: string[] = []
    const post = async (type: number, content: string) => {
      const sent = await this.api.request('POST', path, { type, target_id: channel.id, content, ...(quote && !ids.length ? { quote: String(quote) } : {}) })
      if (sent?.msg_id) ids.push(String(sent.msg_id))
    }
    const markdown = segments.find((item) => item.type === 'markdown')
    if (markdown) await post(MessageType.kmarkdown, String(markdown.data.content ?? markdown.data.text ?? ''))
    const { content, type } = buildContent(segments)
    if (content.trim()) await post(type, content)
    for (const segment of segments) {
      const kind = segment.type === 'image' ? MessageType.image : segment.type === 'video' ? MessageType.video : segment.type === 'record' ? MessageType.audio : segment.type === 'file' ? MessageType.file : undefined
      if (kind) await post(kind, await this.asset(segment))
    }
    return { messageId: ids[0] }
  }

  /** A KOOK asset address for a media segment; other addresses and local files are uploaded. */
  private async asset(segment: Segment) {
    const source = await mediaSource(segment)
    if (source.kind === 'url' && /^https?:\/\/[^/]*\.(kookapp|kaiheila)\.cn\//.test(source.url)) return source.url
    const file = await mediaBytes(segment)
    const form = new FormData()
    form.set('file', new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name)
    const result = await this.api.request('POST', '/asset/create', form)
    return String(result.url)
  }

  private async guild(id: string) {
    const known = this.guilds.get(id)
    if (known && Date.now() - known.at < ROLE_CACHE_MS) return known
    const [view, roles] = await Promise.all([
      this.api.request('GET', '/guild/view', { guild_id: id }),
      this.api.request('GET', '/guild-role/list', { guild_id: id, page_size: 100 }).catch(() => ({ items: [] })),
    ])
    const adminRoles = new Set<number>((roles?.items ?? []).filter((role: any) => (role.permissions & ADMINISTRATOR) === ADMINISTRATOR).map((role: any) => Number(role.role_id)))
    const info = { owner: view?.master_id ? String(view.master_id) : undefined, adminRoles, at: Date.now() }
    this.guilds.set(id, info)
    return info
  }

  /** A member's role: the server owner, an administrator role, or a member. */
  async roleOf(channelId: string, userId: string): Promise<GroupRole | undefined> {
    const guildId = this.channelGuilds.get(channelId)
    if (!guildId) return
    const key = `${guildId}|${userId}`
    const hit = this.roles.get(key)
    if (hit && Date.now() - hit.at < ROLE_CACHE_MS) return hit.role
    const guild = await this.guild(guildId)
    let role: GroupRole = 'member'
    if (guild.owner === userId) role = 'owner'
    else {
      const user = await this.api.request('GET', '/user/view', { user_id: userId, guild_id: guildId })
      if ((user?.roles ?? []).some((id: number) => guild.adminRoles.has(Number(id)))) role = 'admin'
    }
    this.roles.set(key, { role, at: Date.now() })
    if (this.roles.size > 2000) this.roles.delete(this.roles.keys().next().value!)
    return role
  }

  /** The text channels of the servers the bot is in. */
  async contacts(): Promise<Contact[]> {
    const guilds = await this.api.request('GET', '/guild/list', { page_size: 50 })
    const contacts: Contact[] = []
    for (const guild of (guilds?.items ?? []).slice(0, 20)) {
      const channels = await this.api.request('GET', '/channel/list', { guild_id: guild.id, type: 1, page_size: 100 }).catch(() => ({ items: [] }))
      for (const channel of channels?.items ?? []) {
        if (channel.is_category) continue
        this.channelGuilds.set(String(channel.id), String(guild.id))
        contacts.push({ type: 'group', id: String(channel.id), name: `#${channel.name} (${guild.name})` })
      }
    }
    return contacts
  }
}

/**
 * WebSocket mode: KOOK sends a hello (s=1), events (s=0, numbered by `sn`), and answers pings
 * (s=2) with pongs (s=3); a dropped connection resumes from the last event it handled.
 */
function startWebSocket(ctx: Context, bot: KookBot) {
  const logger = ctx.logger('kook')
  let socket: WebSocket | undefined
  let ping: NodeJS.Timeout | undefined
  let pongTimer: NodeJS.Timeout | undefined
  let helloTimer: NodeJS.Timeout | undefined
  let retryTimer: NodeJS.Timeout | undefined
  let delay = RECONNECT_MIN
  let stopped = false
  let session: { id: string; url: string } | undefined

  const clearTimers = () => {
    clearInterval(ping)
    clearTimeout(pongTimer)
    clearTimeout(helloTimer)
  }

  const scheduleReconnect = () => {
    if (stopped || retryTimer) return
    logger.info('reconnecting in %ds', Math.round(delay / 1000))
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      connect().catch(() => {})
    }, delay)
    delay = Math.min(delay * 2, RECONNECT_MAX)
  }

  const connect = async () => {
    if (ctx.bot.status !== 'error') ctx.bot.setStatus('connecting')
    let url: string
    try {
      if (!ctx.bot.selfId) await bot.login()
      if (session) {
        const resume = new URL(session.url)
        resume.searchParams.set('resume', '1')
        resume.searchParams.set('sn', String(bot.sn))
        resume.searchParams.set('session_id', session.id)
        url = resume.href
      } else {
        url = (await bot.api.request<{ url: string }>('GET', '/gateway/index', { compress: 0 })).url
        bot.resetSn()
      }
    } catch (error: any) {
      if (stopped) return
      logger.warn('cannot reach KOOK: %s', error.message)
      ctx.bot.setStatus('error', error instanceof KookError && error.code === 401 ? 'KOOK refused the bot token; copy it again from the developer center' : `Cannot reach KOOK: ${error.message}`)
      if (!(error instanceof KookError && error.code === 401)) scheduleReconnect()
      return
    }
    if (stopped) return
    logger.info(session ? 'resuming session %s' : 'connecting to the gateway', session?.id)
    const gateway = url.split('?')[0]
    const current = socket = new WebSocket(url)
    const send = (payload: unknown) => current.readyState === WebSocket.OPEN && current.send(JSON.stringify(payload))

    current.on('open', () => {
      helloTimer = setTimeout(() => {
        logger.warn('KOOK sent no hello, reconnecting')
        session = undefined
        current.terminate()
      }, HELLO_TIMEOUT)
    })

    current.on('message', (raw) => {
      let payload: any
      try {
        payload = JSON.parse(raw.toString())
      } catch {
        return logger.warn('received a non-JSON frame')
      }
      switch (payload.s) {
        case 1: {
          clearTimeout(helloTimer)
          const code = payload.d?.code ?? 0
          if (code !== 0) {
            logger.warn('KOOK refused the connection (code %d)', code)
            session = undefined
            if (TOKEN_CODES.has(code)) {
              ctx.bot.setStatus('error', `KOOK refused the bot token (code ${code})`)
              stopped = true
            }
            return current.close(1000)
          }
          if (payload.d?.session_id) session = { id: String(payload.d.session_id), url: session?.url ?? gateway }
          delay = RECONNECT_MIN
          clearInterval(ping)
          ping = setInterval(() => {
            send({ s: 2, sn: bot.sn })
            clearTimeout(pongTimer)
            pongTimer = setTimeout(() => {
              logger.warn('KOOK did not answer a ping, reconnecting')
              current.terminate()
            }, PONG_TIMEOUT)
          }, PING_INTERVAL)
          ctx.bot.setStatus('online')
          return
        }
        case 3:
          clearTimeout(pongTimer)
          return
        case 5:
          logger.info('KOOK asked to reconnect (code %s)', payload.d?.code ?? '?')
          session = undefined
          bot.resetSn()
          return current.close(1000)
        case 6:
          logger.info('session resumed')
          if (payload.d?.session_id) session = { id: String(payload.d.session_id), url: session?.url ?? gateway }
          ctx.bot.setStatus('online')
          return
        case 0:
          try {
            bot.handle(payload.d, payload.sn)
          } catch (error) {
            logger.warn('failed to handle event %s: %s', payload.sn, error)
          }
      }
    })
    current.on('error', (error) => {
      if (!stopped) logger.warn('gateway error: %s', error.message)
    })
    current.on('close', (code) => {
      clearTimers()
      if (stopped || current !== socket) return
      logger.info('gateway closed (code %d)', code)
      if (ctx.bot.status === 'online') ctx.bot.setStatus('connecting')
      scheduleReconnect()
    })
  }

  connect().catch(() => {})
  ctx.effect(() => () => {
    stopped = true
    clearTimers()
    clearTimeout(retryTimer)
    socket?.terminate()
  }, 'kook websocket connection')
}

/** Webhook mode: answers KOOK's address check (`WEBHOOK_CHALLENGE`) and takes events with the right verify token. */
function startWebhook(ctx: Context, config: AdapterConfig, bot: KookBot) {
  const logger = ctx.logger('kook')
  const path = inboundPath(config, ctx.bot.id)
  let stopped = false
  let retry: NodeJS.Timeout | undefined

  const login = async () => {
    if (stopped) return
    if (ctx.bot.status !== 'error') ctx.bot.setStatus('connecting')
    try {
      await bot.login()
      if (stopped) return
      logger.info('events are posted to %s', path)
      ctx.bot.setStatus('online')
    } catch (error: any) {
      if (stopped) return
      logger.warn('cannot reach KOOK: %s', error.message)
      ctx.bot.setStatus('error', `Cannot reach KOOK: ${error.message}`)
      retry = setTimeout(login, LOGIN_RETRY)
    }
  }
  login()

  ctx.server.post(path, async (req, res) => {
    let payload: any
    try {
      payload = readWebhookBody(Buffer.from(await req.arrayBuffer()), config.encryptKey)
    } catch (error: any) {
      logger.warn('cannot read a posted event: %s', error.message)
      res.status = 400
      res.json({ error: 'unreadable body' })
      return
    }
    const d = payload?.d ?? {}
    if (config.verifyToken && d.verify_token !== config.verifyToken) {
      logger.warn('refused an event with a wrong verify token; check the Verify Token')
      res.status = 401
      res.json({ error: 'bad verify token' })
      return
    }
    if (d.type === MessageType.system && d.channel_type === 'WEBHOOK_CHALLENGE') {
      logger.info('KOOK checked the callback address %s', path)
      res.json({ challenge: d.challenge })
      return
    }
    res.json({})
    try {
      bot.handle(d, payload.sn)
    } catch (error) {
      logger.warn('failed to handle event %s: %s', payload.sn, error)
    }
  })

  ctx.effect(() => () => {
    stopped = true
    clearTimeout(retry)
  }, 'kook webhook')
}

const Connection = {
  name: 'kook',
  inject: ['bot'],
  Config: AdapterConfig,
  apply(ctx: Context, config: AdapterConfig) {
    const api = new KookApi(config.token, config.endpoint)
    const bot = new KookBot(ctx, api)
    if (config.mode === 'webhook') ctx.inject(['server'], (ctx) => startWebhook(ctx, config, bot))
    else startWebSocket(ctx, bot)
    ctx.bot.useTransport({
      send: (channel, segments) => bot.send(channel, segments),
      call: (action, params) => {
        // `GET /user/me`, `POST /message/create`… as "METHOD /path".
        const [method, path] = /^(GET|POST)\s+(\/\S*)$/i.exec(action)?.slice(1) ?? []
        if (!method) throw new Error('KOOK API calls are written as "METHOD /path", e.g. "GET /user/me"')
        return api.request(method.toUpperCase() as 'GET' | 'POST', path, params)
      },
    })
    ctx.bot.useRoleResolver(({ channel, user }) => bot.roleOf(channel.id, user.id))
    ctx.bot.useContacts(() => bot.contacts())
  },
}

function describeConnection(config: AdapterConfig, botId: string) {
  if (config.mode === 'webhook') return { mode: 'webhook', inbound: inboundPath(config, botId) }
  return { mode: 'ws', address: 'www.kookapp.cn' }
}

export function apply(ctx: Context) {
  ctx.bots.defineAdapter({
    id: 'kook',
    displayName: 'KOOK',
    description: { en: 'A bot from the KOOK developer center', 'zh-CN': 'KOOK 开发者中心里的机器人' },
    icon: '<path fill="currentColor" d="M5 3h3.4v7.4L14.8 3H19l-6.6 7.7L19.4 21h-4.2l-5-7.6l-1.8 2V21H5z"/>',
    color: '#4CBF2A',
    config: AdapterConfig,
    secrets: ['token', 'verifyToken', 'encryptKey'],
    segments: KOOK_SEGMENTS,
    groupRoles: true,
    hiddenFields: { '*': ['endpoint'], websocket: ['verifyToken', 'encryptKey', 'path'], webhook: [] },
    links: [{ url: 'https://developer.kookapp.cn/app/index', label: { en: 'KOOK developer center', 'zh-CN': 'KOOK 开发者中心' } }],
    plugin: Connection,
    describe: (config, botId) => describeConnection(AdapterConfig.parse(config), botId),
  })
}
