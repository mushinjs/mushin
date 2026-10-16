import { WebSocket } from 'ws'
import { type Context, field, z } from '@mushin/core'
import type {} from '@mushin/plugin-bots'
import type {} from '@cordisjs/plugin-server'
import { ONEBOT_SEGMENTS, OneBotConnection } from './protocol'

export * from './protocol'

export const name = 'adapter-onebot'
export const inject = ['bots']

export const AdapterConfig = z.object({
  mode: z.enum(['forward', 'reverse']).default('forward').meta(field(
    'Connection mode',
    'forward: Mushin connects to NapCat\'s WebSocket server. reverse: NapCat\'s WebSocket client connects to Mushin.',
    { 'zh-CN': { title: '连接方式', description: 'forward（正向）：Mushin 连接 NapCat 的 WebSocket 服务器。reverse（反向）：NapCat 的 WebSocket 客户端连接 Mushin。' } },
  )),
  url: z.string().regex(/^wss?:\/\//, 'must start with ws:// or wss://').default('ws://127.0.0.1:3001').meta(field(
    'NapCat address',
    'Address of NapCat\'s WebSocket server',
    { 'zh-CN': { title: 'NapCat 地址', description: 'NapCat WebSocket 服务器的地址' } },
  )),
  path: z.string().regex(/^(\/[\w.~-]*)*$/, 'must be a path such as /onebot/mybot').default('').meta(field(
    'Path',
    'Path NapCat connects to; empty means /onebot/<bot id>',
    { 'zh-CN': { title: '路径', description: 'NapCat 连接的路径；留空则为 /onebot/<机器人 id>' } },
  )),
  token: z.string().default('').meta(field(
    'Access token',
    'The token configured in NapCat',
    { 'zh-CN': { title: '访问令牌', description: '与 NapCat 中配置的 token 相同' } },
  )),
})

export type AdapterConfig = z.infer<typeof AdapterConfig>

const RECONNECT_MIN = 1_000
const RECONNECT_MAX = 30_000

/** Forward mode: dial NapCat, retrying with backoff from 1 to 30 seconds. */
const Forward = {
  name: 'onebot-forward',
  inject: ['bot'],
  apply(ctx: Context, config: AdapterConfig) {
    const logger = ctx.logger('onebot')
    let socket: WebSocket | undefined
    let connection: OneBotConnection | undefined
    let retryTimer: NodeJS.Timeout | undefined
    let delay = RECONNECT_MIN
    let stopped = false

    const scheduleReconnect = () => {
      if (stopped || retryTimer) return
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        connect()
      }, delay)
      delay = Math.min(delay * 2, RECONNECT_MAX)
    }

    const connect = () => {
      // Keep an error visible while retrying, so the dashboard shows why it is not connected.
      if (ctx.bot.status !== 'error') ctx.bot.setStatus('connecting')
      const headers: Record<string, string> = config.token ? { Authorization: `Bearer ${config.token}` } : {}
      const current = socket = new WebSocket(config.url, { headers })
      current.on('open', () => {
        if (stopped) return current.terminate()
        delay = RECONNECT_MIN
        connection = new OneBotConnection(ctx, current, scheduleReconnect)
        connection.login().catch((error) => {
          logger.warn('get_login_info failed: %s', error)
          ctx.bot.setStatus('error', `Connected, but get_login_info failed: ${error.message}`)
        })
      })
      current.on('unexpected-response', (_req, res) => {
        if (stopped) return
        const reason = res.statusCode === 401 || res.statusCode === 403
          ? 'NapCat rejected the access token'
          : `NapCat answered HTTP ${res.statusCode}`
        ctx.bot.setStatus('error', reason)
        current.terminate()
      })
      current.on('error', (error) => {
        if (stopped) return
        if (ctx.bot.status !== 'error') ctx.bot.setStatus('error', `Cannot reach ${config.url}: ${error.message}`)
      })
      current.on('close', () => {
        connection?.dispose()
        connection = undefined
        if (stopped || current !== socket) return
        if (ctx.bot.status === 'online') ctx.bot.setStatus('offline')
        scheduleReconnect()
      })
    }

    ctx.bot.useTransport({
      send: (channel, segments) => {
        if (!connection) throw new Error('not connected to NapCat')
        return connection.send(channel, segments)
      },
      call: (action, params) => {
        if (!connection) throw new Error('not connected to NapCat')
        return connection.call(action, params)
      },
    })

    connect()
    ctx.effect(() => () => {
      stopped = true
      clearTimeout(retryTimer)
      connection?.dispose()
      socket?.terminate()
    }, 'onebot forward connection')
  },
}

/** Reverse mode: NapCat dials `ws://<mushin>/<path>`; a new connection replaces the previous one. */
const Reverse = {
  name: 'onebot-reverse',
  inject: ['bot', 'server'],
  apply(ctx: Context, config: AdapterConfig) {
    const logger = ctx.logger('onebot')
    const path = config.path || `/onebot/${ctx.bot.id}`
    let connection: OneBotConnection | undefined
    let socket: WebSocket | undefined
    let stopped = false

    ctx.bot.setStatus('connecting')
    ctx.server.ws(path, async (req, accept) => {
      if (stopped) return
      if (config.token) {
        const header = req.headers.get('authorization') ?? ''
        const supplied = header.replace(/^(Bearer|Token)\s+/i, '') || req.query.get('access_token') || ''
        if (supplied !== config.token) {
          logger.warn('rejected a reverse connection to %s: wrong access token', path)
          ctx.bot.setStatus('error', 'NapCat connected with a wrong access token')
          return
        }
      }
      const current = await accept()
      socket?.close(1000, 'replaced by a new connection')
      connection?.dispose()
      socket = current
      connection = new OneBotConnection(ctx, current, () => {})
      current.on('close', () => {
        if (stopped || socket !== current) return
        connection?.dispose()
        connection = undefined
        socket = undefined
        ctx.bot.setStatus('connecting')
      })
      const selfId = req.headers.get('x-self-id')
      if (selfId) ctx.bot.setSelf(selfId)
      connection.login().catch((error) => {
        logger.warn('get_login_info failed: %s', error)
        ctx.bot.setStatus('error', `Connected, but get_login_info failed: ${error.message}`)
      })
    })

    ctx.bot.useTransport({
      send: (channel, segments) => {
        if (!connection) throw new Error('NapCat is not connected')
        return connection.send(channel, segments)
      },
      call: (action, params) => {
        if (!connection) throw new Error('NapCat is not connected')
        return connection.call(action, params)
      },
    })

    ctx.effect(() => () => {
      stopped = true
      connection?.dispose()
      socket?.close(1001, 'bot stopped')
    }, 'onebot reverse connection')
  },
}

/** Loaded inside each bot's context; picks the connection mode from the bot's adapter config. */
const Connection = {
  name: 'onebot',
  inject: ['bot'],
  Config: AdapterConfig,
  apply(ctx: Context, config: AdapterConfig) {
    ctx.plugin(config.mode === 'reverse' ? Reverse : Forward, config)
  },
}

export function apply(ctx: Context) {
  ctx.bots.defineAdapter({
    id: 'onebot',
    displayName: 'OneBot v11 (NapCat)',
    config: AdapterConfig,
    secrets: ['token'],
    segments: ONEBOT_SEGMENTS,
    plugin: Connection,
  })
}
