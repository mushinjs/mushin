import { createHmac, timingSafeEqual } from 'node:crypto'
import { WebSocket } from 'ws'
import { type Context, field, z } from '@mushin/core'
import type { GroupRole } from '@mushin/plugin-bots'
import type {} from '@cordisjs/plugin-server'
import type {} from '@mushin/plugin-flows'
import { onebotNodes } from './nodes'
import { ONEBOT_SEGMENTS, OneBotConnection, type OneBotResponse } from './protocol'

export * from './events'
export * from './nodes'
export * from './protocol'

export const name = 'adapter-onebot'
export const inject = ['bots']

export const AdapterConfig = z.object({
  mode: z.enum(['forward', 'reverse', 'http']).default('forward').meta(field(
    'Connection mode',
    'forward: Mushin connects to NapCat\'s WebSocket server. reverse: NapCat\'s WebSocket client connects to Mushin. http: Mushin calls NapCat\'s HTTP server, and NapCat\'s HTTP client posts events to Mushin.',
    { 'zh-CN': { title: '连接方式', description: 'forward（正向 WebSocket）：Mushin 连接 NapCat 的 WebSocket 服务器。reverse（反向 WebSocket）：NapCat 的 WebSocket 客户端连接 Mushin。http：Mushin 调用 NapCat 的 HTTP 服务器，NapCat 的 HTTP 客户端把事件上报给 Mushin。' } },
  )),
  url: z.string().regex(/^(wss?|https?):\/\//, 'must start with ws://, wss://, http:// or https://').default('ws://127.0.0.1:3001').meta(field(
    'NapCat address',
    'Address of NapCat\'s WebSocket server (forward), or of its HTTP server (http), e.g. http://127.0.0.1:3000',
    { 'zh-CN': { title: 'NapCat 地址', description: 'NapCat WebSocket 服务器的地址（正向），或 HTTP 服务器的地址（http），例如 http://127.0.0.1:3000' } },
  )),
  path: z.string().regex(/^(\/[\w.~-]*)*$/, 'must be a path such as /onebot/mybot').default('').meta(field(
    'Path',
    'Path NapCat connects (reverse) or posts events (http) to; empty means /onebot/<bot id>',
    { 'zh-CN': { title: '路径', description: 'NapCat 连接（反向）或上报事件（http）的路径；留空则为 /onebot/<机器人 id>' } },
  )),
  token: z.string().default('').meta(field(
    'Access token',
    'The token configured in NapCat',
    { 'zh-CN': { title: '访问令牌', description: '与 NapCat 中配置的 token 相同' } },
  )),
  secret: z.string().default('').meta(field(
    'Report secret',
    'http mode: the secret of NapCat\'s HTTP client; events without a matching X-Signature are refused. Empty accepts unsigned events.',
    { 'zh-CN': { title: '上报密钥', description: 'http 模式：NapCat HTTP 客户端里的 secret；签名（X-Signature）不匹配的事件会被拒绝。留空则接受不带签名的事件。' } },
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
        connection = OneBotConnection.overSocket(ctx, current, scheduleReconnect)
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
    const path = inboundPath(config, ctx.bot.id)
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
      connection = OneBotConnection.overSocket(ctx, current, () => {})
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

/** Where NapCat reaches Mushin in reverse and http modes. */
const inboundPath = (config: AdapterConfig, botId: string) => config.path || `/onebot/${botId}`

/** Checks an HTTP report's `X-Signature: sha1=<hex>`, an HMAC-SHA1 of the body with the secret. */
export function signatureMatches(secret: string, body: string, header: string | null) {
  if (!secret) return true
  const supplied = (header ?? '').replace(/^sha1=/i, '').trim().toLowerCase()
  const expected = createHmac('sha1', secret).update(body).digest('hex')
  return supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
}

const HTTP_TIMEOUT = 30_000
const LOGIN_RETRY = 30_000

/**
 * HTTP mode: API calls are POSTs to NapCat's HTTP server; NapCat's HTTP client posts events to
 * `/onebot/<bot id>` (or the configured path), signed with the report secret when one is set.
 */
const Http = {
  name: 'onebot-http',
  inject: ['bot', 'server'],
  apply(ctx: Context, config: AdapterConfig) {
    const logger = ctx.logger('onebot')
    const base = config.url.replace(/\/+$/, '')
    const path = inboundPath(config, ctx.bot.id)
    let stopped = false
    let retry: NodeJS.Timeout | undefined

    if (!/^https?:\/\//.test(base)) {
      ctx.bot.setStatus('error', `HTTP mode needs an http:// or https:// address, not ${config.url}`)
      return
    }

    const connection = new OneBotConnection(ctx, {
      request: async (action, params) => {
        const response = await fetch(`${base}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(HTTP_TIMEOUT),
        })
        if (response.status === 401 || response.status === 403) throw new Error('NapCat rejected the access token')
        if (!response.ok) throw new Error(`NapCat answered HTTP ${response.status}`)
        return await response.json() as OneBotResponse
      },
      close: () => {},
    }, () => {}, false)

    // Without a lasting connection, "online" means NapCat answered get_login_info; keep trying until it does.
    const login = () => {
      if (stopped) return
      if (ctx.bot.status !== 'error') ctx.bot.setStatus('connecting')
      connection.login().catch((error) => {
        if (stopped) return
        logger.warn('cannot reach NapCat at %s: %s', base, error.message)
        ctx.bot.setStatus('error', `Cannot reach NapCat at ${base}: ${error.message}`)
        retry = setTimeout(login, LOGIN_RETRY)
      })
    }
    logger.info('calling NapCat at %s%s; events are posted to %s%s', base, config.token ? ' with a token' : '', path, config.secret ? ' (signed)' : '')
    login()

    ctx.server.post(path, async (req, res) => {
      const body = await req.text()
      if (!signatureMatches(config.secret, body, req.headers.get('x-signature'))) {
        logger.warn('refused an event with a missing or wrong X-Signature; check the secret in NapCat\'s HTTP client')
        res.status = 401
        res.json({ error: 'bad signature' })
        return
      }
      // An answer with no quick operation; replies go through the API.
      res.status = 204
      res.body = null
      if (ctx.bot.status !== 'online' && !retry) login()
      connection.receive(body)
    })

    ctx.bot.useTransport({
      send: (channel, segments) => connection.send(channel, segments),
      call: (action, params) => connection.call(action, params),
    })

    ctx.effect(() => () => {
      stopped = true
      clearTimeout(retry)
      connection.dispose()
    }, 'onebot http connection')
  },
}

/** Loaded inside each bot's context; picks the connection mode from the bot's adapter config. */
const Connection = {
  name: 'onebot',
  inject: ['bot'],
  Config: AdapterConfig,
  apply(ctx: Context, config: AdapterConfig) {
    ctx.plugin(config.mode === 'reverse' ? Reverse : config.mode === 'http' ? Http : Forward, config)
    ctx.bot.useRoleResolver(groupRoleResolver(ctx))
  },
}

const ROLE_CACHE_MS = 5 * 60_000

/**
 * Group roles for permission checks. Messages carry the sender's role; events do not, so those ask
 * NapCat (`get_group_member_info`), and the answer is kept a few minutes per group and user.
 */
function groupRoleResolver(ctx: Context) {
  const cache = new Map<string, { role: GroupRole | undefined; at: number }>()
  return async ({ channel, user }: { channel: { id: string }; user: { id: string } }) => {
    const key = `${channel.id}|${user.id}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ROLE_CACHE_MS) return hit.role
    const data = await ctx.bot.call('get_group_member_info', { group_id: Number(channel.id) || channel.id, user_id: Number(user.id) || user.id })
    const role = data?.role === 'owner' || data?.role === 'admin' || data?.role === 'member' ? data.role as GroupRole : undefined
    cache.set(key, { role, at: Date.now() })
    if (cache.size > 2000) cache.delete(cache.keys().next().value!)
    return role
  }
}

/** How a bot connects, for the bots list. */
function describeConnection(config: AdapterConfig, botId: string) {
  if (config.mode === 'reverse') return { mode: 'ws-reverse', address: inboundPath(config, botId) }
  if (config.mode === 'http') return { mode: 'http', address: config.url, inbound: inboundPath(config, botId) }
  return { mode: 'ws', address: config.url }
}

export function apply(ctx: Context) {
  ctx.bots.defineAdapter({
    id: 'onebot',
    displayName: 'OneBot v11 (NapCat)',
    config: AdapterConfig,
    secrets: ['token', 'secret'],
    segments: ONEBOT_SEGMENTS,
    groupRoles: true,
    plugin: Connection,
    describe: (config, botId) => describeConnection(AdapterConfig.parse(config), botId),
  })
  // Flow nodes for OneBot events and APIs, while the flows plugin is running.
  ctx.inject(['flows'], (ctx) => {
    for (const node of onebotNodes) ctx.flows.defineNode(node)
  })
}
