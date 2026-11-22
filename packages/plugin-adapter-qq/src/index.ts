import { WebSocket } from 'ws'
import { type Context, field, z } from '@mushinjs/core'
import type {} from '@mushinjs/plugin-bots'
import type {} from '@cordisjs/plugin-server'
import { QQApi } from './api'
import { decodeEvent, decodeMessage, QQ_SEGMENTS } from './message'
import { QQSender } from './sender'
import { signChallenge, verifyRequest, webhookKey } from './signature'

export * from './api'
export * from './message'
export * from './sender'
export * from './signature'

export const name = 'adapter-qq'
export const inject = ['bots']

export const AdapterConfig = z.object({
  mode: z.enum(['websocket', 'webhook']).default('websocket').meta(field(
    'Connection mode',
    'websocket: Mushin connects to QQ\'s gateway; works without a public address. webhook: QQ posts events to Mushin, which needs a public HTTPS address.',
    { 'zh-CN': { title: '接入方式', description: 'websocket：Mushin 连接 QQ 的网关，不需要公网地址。webhook：QQ 把事件推送到 Mushin，需要公网 HTTPS 地址。' } },
  )),
  appId: z.string().default('').meta(field(
    'AppID',
    'From the QQ Open Platform (q.qq.com): Development → Development settings',
    { 'zh-CN': { title: 'AppID', description: '在 QQ 开放平台（q.qq.com）的「开发 → 开发设置」中查看' } },
  )),
  secret: z.string().default('').meta(field(
    'AppSecret',
    'From the same page; also used to sign webhook answers',
    { 'zh-CN': { title: 'AppSecret', description: '同一页面中的 AppSecret，Webhook 模式还用它签名' } },
  )),
  sandbox: z.boolean().default(false).meta(field(
    'Sandbox',
    'Use the sandbox environment, where only the sandbox guilds and groups set on the platform see the bot',
    { 'zh-CN': { title: '沙箱环境', description: '使用沙箱环境，只有在平台上配置的沙箱频道和群能看到机器人' } },
  )),
  groups: z.boolean().default(true).meta(field(
    'Group and private chats',
    'Receive group @-messages and private (C2C) messages. Turn off for a bot that only has guild permissions.',
    { 'zh-CN': { title: '群聊和单聊', description: '接收群里 @ 机器人的消息和单聊消息。只有频道权限的机器人请关闭。' } },
  )),
  guilds: z.boolean().default(true).meta(field(
    'Guilds',
    'Receive guild messages that @-mention the bot, and guild DMs',
    { 'zh-CN': { title: '频道', description: '接收频道里 @ 机器人的消息和频道私信' } },
  )),
  allGuildMessages: z.boolean().default(false).meta(field(
    'All guild messages',
    'Receive every guild message, not only mentions; needs a private (私域) bot',
    { 'zh-CN': { title: '频道全部消息', description: '接收频道里的所有消息，而不只是 @ 机器人的；需要私域机器人' } },
  )),
  path: z.string().regex(/^(\/[\w.~-]*)*$/, 'must be a path such as /qq/mybot').default('').meta(field(
    'Webhook path',
    'Path QQ posts events to; empty means /qq/<bot id>. Set the callback address on the platform to https://<your domain><path>.',
    { 'zh-CN': { title: 'Webhook 路径', description: 'QQ 推送事件的路径；留空则为 /qq/<机器人 id>。在平台上把回调地址设为 https://<你的域名><路径>。' } },
  )),
  endpoint: z.string().default('').meta(field('API address', 'Leave empty for QQ\'s OpenAPI')),
  tokenEndpoint: z.string().default('').meta(field('Token address', 'Leave empty for QQ\'s token service')),
})

export type AdapterConfig = z.infer<typeof AdapterConfig>

export const Intents = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
}

/** The gateway intents for a config: what the bot listens to. */
export function intentsOf(config: Pick<AdapterConfig, 'groups' | 'guilds' | 'allGuildMessages'>) {
  let intents = 0
  if (config.groups) intents |= Intents.GROUP_AND_C2C_EVENT
  if (config.guilds) {
    intents |= Intents.GUILDS | Intents.GUILD_MEMBERS | Intents.DIRECT_MESSAGE | Intents.PUBLIC_GUILD_MESSAGES
    if (config.allGuildMessages) intents |= Intents.GUILD_MESSAGES
  }
  return intents
}

const RECONNECT_MIN = 1_000
const RECONNECT_MAX = 60_000
const LOGIN_RETRY = 30_000

/** Gateway close codes after which reconnecting cannot help, with what to tell the person. */
const FATAL_CLOSE: Record<number, string> = {
  4010: 'QQ refused the shard settings',
  4011: 'the bot is in too many guilds for one connection',
  4012: 'QQ refused the gateway version',
  4013: 'QQ refused the intents; turn off "All guild messages" unless this is a private bot',
  4014: 'the bot has no permission for some events; turn off "Group and private chats" or "All guild messages" if the bot lacks them',
  4914: 'the bot is offline (still under review?); only the sandbox can reach it',
  4915: 'the bot is banned',
}

/** Gateway close codes after which the session cannot be resumed. */
const NEW_SESSION = new Set([4006, 4007, 4008, 4009])

/** Hands a dispatched event to the bot: messages to `receive`, the rest to `dispatchEvent`. */
function dispatch(ctx: Context, sender: QQSender, type: string, d: any, eventId?: string) {
  const logger = ctx.logger('qq')
  const message = decodeMessage(type, d, ctx.bot.selfId)
  if (message) {
    sender.track(message.channel, { msgId: message.messageId, dmsGuild: message.dmsGuild })
    const { dmsGuild: _, ...incoming } = message
    ctx.bot.receive(incoming).catch((error) => logger.warn('failed to handle message: %s', error))
    return
  }
  const event = decodeEvent(type, d, eventId)
  if (event.channel && eventId) sender.track(event.channel, { eventId })
  ctx.bot.dispatchEvent(event)
}

/** WebSocket mode: identify at the gateway, keep a heartbeat, resume after a drop. */
function startGateway(ctx: Context, config: AdapterConfig, api: QQApi, sender: QQSender) {
  const logger = ctx.logger('qq')
  let socket: WebSocket | undefined
  let heartbeat: NodeJS.Timeout | undefined
  let retryTimer: NodeJS.Timeout | undefined
  let delay = RECONNECT_MIN
  let stopped = false
  let session: { id: string; seq?: number } | undefined
  let seq: number | undefined

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
      url = (await api.request<{ url: string }>('GET', '/gateway')).url
      if (!url) throw new Error('QQ returned no gateway address')
    } catch (error: any) {
      if (stopped) return
      logger.warn('cannot get the gateway address: %s', error.message)
      ctx.bot.setStatus('error', `Cannot reach QQ: ${error.message}`)
      return scheduleReconnect()
    }
    if (stopped) return
    logger.info('connecting to %s', url)
    const current = socket = new WebSocket(url)
    const send = (payload: unknown) => current.readyState === WebSocket.OPEN && current.send(JSON.stringify(payload))

    current.on('message', async (raw) => {
      let payload: any
      try {
        payload = JSON.parse(raw.toString())
      } catch {
        return logger.warn('received a non-JSON frame')
      }
      if (typeof payload.s === 'number') seq = payload.s
      switch (payload.op) {
        case 10: {
          clearInterval(heartbeat)
          const interval = Number(payload.d?.heartbeat_interval) || 40_000
          heartbeat = setInterval(() => send({ op: 1, d: seq ?? null }), interval)
          const token = `QQBot ${await api.accessToken()}`
          if (session) {
            logger.info('resuming session %s', session.id)
            send({ op: 6, d: { token, session_id: session.id, seq: session.seq ?? seq ?? 0 } })
          } else {
            send({ op: 2, d: { token, intents: intentsOf(config), shard: [0, 1], properties: {} } })
          }
          return
        }
        case 0: {
          if (session) session.seq = seq
          if (payload.t === 'READY') {
            session = { id: String(payload.d?.session_id), seq }
            delay = RECONNECT_MIN
            const user = payload.d?.user ?? {}
            if (user.id) ctx.bot.setSelf(String(user.id), user.username, user.avatar || undefined)
            logger.info('logged in as %s (%s)', user.username ?? 'unknown', user.id ?? '?')
            ctx.bot.setStatus('online')
          } else if (payload.t === 'RESUMED') {
            delay = RECONNECT_MIN
            logger.info('session resumed')
            ctx.bot.setStatus('online')
          } else if (payload.t) {
            dispatch(ctx, sender, String(payload.t), payload.d, payload.id ? String(payload.id) : undefined)
          }
          return
        }
        case 7:
          logger.info('QQ asked to reconnect')
          return current.close(4000, 'reconnect')
        case 9:
          logger.info('the session is no longer valid, starting a new one')
          session = undefined
          return current.close(4000, 'invalid session')
      }
    })
    current.on('error', (error) => {
      if (stopped) return
      logger.warn('gateway error: %s', error.message)
    })
    current.on('close', (code, reason) => {
      clearInterval(heartbeat)
      if (stopped || current !== socket) return
      const text = reason.toString()
      logger.info('gateway closed (code %d%s)', code, text ? `, ${text}` : '')
      if (FATAL_CLOSE[code]) {
        ctx.bot.setStatus('error', `QQ closed the connection: ${FATAL_CLOSE[code]} (code ${code})`)
        return
      }
      if (code === 4004) api.invalidate()
      if (NEW_SESSION.has(code) || code === 4004) session = undefined
      if (ctx.bot.status === 'online') ctx.bot.setStatus('connecting')
      scheduleReconnect()
    })
  }

  connect().catch(() => {})
  ctx.effect(() => () => {
    stopped = true
    clearTimeout(retryTimer)
    clearInterval(heartbeat)
    socket?.terminate()
  }, 'qq gateway connection')
}

/** Where QQ posts events in webhook mode. */
const inboundPath = (config: AdapterConfig, botId: string) => config.path || `/qq/${botId}`

/**
 * Webhook mode: QQ checks the callback address with a signed challenge (op 13), then posts each
 * event signed with Ed25519; Mushin answers with an ACK (op 12).
 */
function startWebhook(ctx: Context, config: AdapterConfig, api: QQApi, sender: QQSender) {
  const logger = ctx.logger('qq')
  const path = inboundPath(config, ctx.bot.id)
  let stopped = false
  let retry: NodeJS.Timeout | undefined
  let key: ReturnType<typeof webhookKey>
  try {
    key = webhookKey(config.secret)
  } catch (error: any) {
    ctx.bot.setStatus('error', error.message)
    return
  }

  // Without a lasting connection, "online" means QQ gave an access token and named the bot.
  const login = async () => {
    if (stopped) return
    if (ctx.bot.status !== 'error') ctx.bot.setStatus('connecting')
    try {
      await api.accessToken()
      const me = await api.request('GET', '/users/@me').catch(() => undefined)
      if (stopped) return
      ctx.bot.setSelf(String(me?.id ?? config.appId), me?.username, me?.avatar || undefined)
      logger.info('logged in as %s; events are posted to %s', me?.username ?? config.appId, path)
      ctx.bot.setStatus('online')
    } catch (error: any) {
      if (stopped) return
      logger.warn('cannot reach QQ: %s', error.message)
      ctx.bot.setStatus('error', `Cannot reach QQ: ${error.message}`)
      retry = setTimeout(login, LOGIN_RETRY)
    }
  }
  login()

  ctx.server.post(path, async (req, res) => {
    const body = await req.text()
    let payload: any
    try {
      payload = JSON.parse(body)
    } catch {
      res.status = 400
      res.json({ error: 'not JSON' })
      return
    }
    if (payload.op === 13) {
      const { plain_token: plainToken, event_ts: eventTs } = payload.d ?? {}
      logger.info('QQ checked the callback address %s', path)
      res.json({ plain_token: plainToken, signature: signChallenge(key, String(eventTs ?? ''), String(plainToken ?? '')) })
      return
    }
    if (!verifyRequest(key, req.headers.get('x-signature-timestamp'), body, req.headers.get('x-signature-ed25519'))) {
      logger.warn('refused an event with a missing or wrong signature; check the AppSecret')
      res.status = 401
      res.json({ error: 'bad signature' })
      return
    }
    res.json({ op: 12, d: 0 })
    if (payload.op === 0 && payload.t) dispatch(ctx, sender, String(payload.t), payload.d, payload.id ? String(payload.id) : undefined)
  })

  ctx.effect(() => () => {
    stopped = true
    clearTimeout(retry)
  }, 'qq webhook')
}

/** Loaded inside each bot's context; picks the connection mode from the bot's adapter config. */
const Connection = {
  name: 'qq',
  inject: ['bot'],
  Config: AdapterConfig,
  apply(ctx: Context, config: AdapterConfig) {
    const api = new QQApi(config)
    const sender = new QQSender(api)
    if (config.mode === 'webhook') ctx.inject(['server'], (ctx) => startWebhook(ctx, config, api, sender))
    else startGateway(ctx, config, api, sender)
    ctx.bot.useTransport({
      send: (channel, segments) => sender.send(channel, segments),
      call: (action, params) => {
        // `GET /users/@me`, `POST /v2/groups/{id}/messages`… as "METHOD /path".
        const [method, path] = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/i.exec(action)?.slice(1) ?? []
        if (!method) throw new Error('QQ API calls are written as "METHOD /path", e.g. "GET /users/@me"')
        return api.request(method.toUpperCase(), path, method.toUpperCase() === 'GET' ? undefined : params)
      },
    })
  },
}

function describeConnection(config: AdapterConfig, botId: string) {
  if (config.mode === 'webhook') return { mode: 'webhook', inbound: inboundPath(config, botId) }
  return { mode: 'ws', address: config.sandbox ? 'sandbox.api.sgroup.qq.com' : 'api.sgroup.qq.com' }
}

export function apply(ctx: Context) {
  ctx.bots.defineAdapter({
    id: 'qq',
    displayName: { en: 'QQ official bot', 'zh-CN': 'QQ 官方机器人' },
    config: AdapterConfig,
    secrets: ['secret'],
    segments: QQ_SEGMENTS,
    hiddenFields: { '*': ['endpoint', 'tokenEndpoint'], websocket: ['path'], webhook: [] },
    plugin: Connection,
    describe: (config, botId) => describeConnection(AdapterConfig.parse(config), botId),
  })
}
