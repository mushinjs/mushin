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

interface IncomingRequest {
  headers: Headers
  query: URLSearchParams
  _req: { socket: { remoteAddress?: string } }
}

/** Where a reverse connection comes from, for the bot's log. */
function describePeer(req: IncomingRequest) {
  const address = req._req.socket.remoteAddress ?? 'an unknown address'
  const selfId = req.headers.get('x-self-id') ?? '?'
  const role = req.headers.get('x-client-role') ?? '?'
  const agent = req.headers.get('user-agent') ?? 'no user agent'
  return `${address} (self id ${selfId}, role ${role}, ${agent})`
}

/** The token a client sent, and how: OneBot allows a Bearer header or an access_token query. */
function readToken(req: IncomingRequest) {
  const header = (req.headers.get('authorization') ?? '').replace(/^(Bearer|Token)\s*/i, '').trim()
  if (header) return { token: header, source: 'the Authorization header' }
  const query = req.query.get('access_token')
  if (query) return { token: query, source: 'the access_token query' }
  return { token: '', source: '' }
}

/** Explains a token mismatch without printing either token. */
function tokenProblem(supplied: { token: string; source: string }, expected: string) {
  if (!supplied.token) return 'NapCat sent no token; set the same token in NapCat\'s WebSocket client'
  return `the token sent in ${supplied.source} (${supplied.token.length} characters) does not match the bot's token (${expected.length} characters)`
}

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
      logger.info('reconnecting in %ds', Math.round(delay / 1000))
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
      logger.info('connecting to %s%s', config.url, config.token ? ' with a token' : ' without a token')
      const current = socket = new WebSocket(config.url, { headers })
      // A socket that never opened has nothing to report on close; the error handler already said why.
      let opened = false
      current.on('open', () => {
        if (stopped) return current.terminate()
        opened = true
        logger.info('connected to %s', config.url)
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
        logger.warn('%s (HTTP %d from %s)', reason, res.statusCode, config.url)
        ctx.bot.setStatus('error', reason)
        current.terminate()
      })
      current.on('error', (error) => {
        if (stopped) return
        logger.warn('cannot reach %s: %s', config.url, error.message)
        if (ctx.bot.status !== 'error') ctx.bot.setStatus('error', `Cannot reach ${config.url}: ${error.message}`)
      })
      current.on('close', (code, reason) => {
        connection?.dispose()
        connection = undefined
        if (stopped || current !== socket) return
        if (opened) logger.info('connection closed (code %d%s)', code, reason.length ? `, ${reason}` : '')
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
    logger.info('waiting for NapCat to connect to %s%s', path, config.token ? ' with a token' : ' (no token required)')
    ctx.server.ws(path, async (req, accept) => {
      if (stopped) return
      const peer = describePeer(req)
      if (config.token) {
        const supplied = readToken(req)
        if (supplied.token !== config.token) {
          const problem = tokenProblem(supplied, config.token)
          if (connection) {
            // Another client (often a second WebSocket client entry in NapCat) must not mark a working bot as broken.
            logger.warn('rejected an extra connection from %s: %s. The current connection stays up.', peer, problem)
          } else {
            logger.warn('rejected a connection from %s: %s', peer, problem)
            ctx.bot.setStatus('error', `NapCat connected with a wrong access token: ${problem}`)
          }
          return
        }
      }
      const role = req.headers.get('x-client-role')
      if (role && role.toLowerCase() !== 'universal') {
        logger.warn('NapCat connected as an "%s" client; use a universal WebSocket client so events and API calls share one connection', role)
      }
      const current = await accept()
      if (socket) logger.info('a new connection from %s replaced the previous one', peer)
      else logger.info('NapCat connected from %s', peer)
      socket?.close(1000, 'replaced by a new connection')
      connection?.dispose()
      socket = current
      connection = new OneBotConnection(ctx, current, () => {})
      current.on('close', (code, reason) => {
        if (stopped || socket !== current) return
        logger.info('NapCat disconnected (code %d%s)', code, reason.length ? `, ${reason}` : '')
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
