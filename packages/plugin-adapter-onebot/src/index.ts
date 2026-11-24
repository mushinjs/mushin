import { createHmac, timingSafeEqual } from 'node:crypto'
import { WebSocket } from 'ws'
import { type Context, field, z } from '@mushinjs/core'
import type { Contact, GroupRole } from '@mushinjs/plugin-bots'
import type {} from '@cordisjs/plugin-server'
import type {} from '@mushinjs/plugin-flows'
import { onebotMedia } from './media'
import { onebotNodes } from './nodes'
import { ONEBOT_SEGMENTS, OneBotConnection, type OneBotResponse, qqAvatar } from './protocol'

export * from './events'
export * from './media'
export * from './nodes'
export * from './protocol'

export const name = 'adapter-onebot'
export const inject = ['bots']

export const AdapterConfig = z.object({
  mode: z.enum(['forward', 'reverse', 'http']).default('forward').meta(field(
    'Connection mode',
    'forward: Mushin connects to the WebSocket server of your OneBot 11 implementation. reverse: its WebSocket client connects to Mushin. http: Mushin calls its HTTP server, and its HTTP client posts events to Mushin.',
    { 'zh-CN': { title: '连接方式', description: 'forward（正向 WebSocket）：Mushin 连接 OneBot 11 实现的 WebSocket 服务器。reverse（反向 WebSocket）：OneBot 11 实现的 WebSocket 客户端连接 Mushin。http：Mushin 调用它的 HTTP 服务器，它的 HTTP 客户端把事件上报给 Mushin。' } },
  )),
  url: z.string().regex(/^(wss?|https?):\/\//, 'must start with ws://, wss://, http:// or https://').default('ws://127.0.0.1:3001').meta(field(
    'OneBot address',
    'Address of the OneBot implementation\'s WebSocket server (forward), or of its HTTP server (http), e.g. http://127.0.0.1:3000',
    { 'zh-CN': { title: 'OneBot 地址', description: 'OneBot 实现的 WebSocket 服务器地址（正向），或 HTTP 服务器地址（http），例如 http://127.0.0.1:3000' } },
  )),
  path: z.string().regex(/^(\/[\w.~-]*)*$/, 'must be a path such as /onebot/mybot').default('').meta(field(
    'Path',
    'Path the OneBot implementation connects (reverse) or posts events (http) to; empty means /onebot/<bot id>',
    { 'zh-CN': { title: '路径', description: 'OneBot 实现连接（反向）或上报事件（http）的路径；留空则为 /onebot/<机器人 id>' } },
  )),
  token: z.string().default('').meta(field(
    'Access token',
    'The access token configured in the OneBot implementation',
    { 'zh-CN': { title: '访问令牌', description: '与 OneBot 实现中配置的 access token 相同' } },
  )),
  secret: z.string().default('').meta(field(
    'Report secret',
    'http mode: the secret of the OneBot implementation\'s HTTP client; events without a matching X-Signature are refused. Empty accepts unsigned events.',
    { 'zh-CN': { title: '上报密钥', description: 'http 模式：OneBot 实现的 HTTP 客户端里的 secret；签名（X-Signature）不匹配的事件会被拒绝。留空则接受不带签名的事件。' } },
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
  if (!supplied.token) return 'the OneBot client sent no token; set the same access token in its WebSocket client'
  return `the token sent in ${supplied.source} (${supplied.token.length} characters) does not match the bot's token (${expected.length} characters)`
}

/** Forward mode: dial the OneBot implementation's WebSocket server, retrying with backoff from 1 to 30 seconds. */
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
          ? 'the OneBot server rejected the access token'
          : `the OneBot server answered HTTP ${res.statusCode}`
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
        if (!connection) throw new Error('not connected to the OneBot server')
        return connection.send(channel, segments)
      },
      call: (action, params) => {
        if (!connection) throw new Error('not connected to the OneBot server')
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

/** Reverse mode: the OneBot implementation dials `ws://<mushin>/<path>`; a new connection replaces the previous one. */
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
    logger.info('waiting for the OneBot client to connect to %s%s', path, config.token ? ' with a token' : ' (no token required)')
    ctx.server.ws(path, async (req, accept) => {
      if (stopped) return
      const peer = describePeer(req)
      if (config.token) {
        const supplied = readToken(req)
        if (supplied.token !== config.token) {
          const problem = tokenProblem(supplied, config.token)
          if (connection) {
            // Another client (often a second WebSocket client entry in the OneBot implementation) must not mark a working bot as broken.
            logger.warn('rejected an extra connection from %s: %s. The current connection stays up.', peer, problem)
          } else {
            logger.warn('rejected a connection from %s: %s', peer, problem)
            ctx.bot.setStatus('error', `the OneBot client connected with a wrong access token: ${problem}`)
          }
          return
        }
      }
      const role = req.headers.get('x-client-role')
      if (role && role.toLowerCase() !== 'universal') {
        logger.warn('the OneBot client connected as an "%s" client; use a universal WebSocket client so events and API calls share one connection', role)
      }
      const current = await accept()
      if (socket) logger.info('a new connection from %s replaced the previous one', peer)
      else logger.info('OneBot client connected from %s', peer)
      socket?.close(1000, 'replaced by a new connection')
      connection?.dispose()
      socket = current
      connection = OneBotConnection.overSocket(ctx, current, () => {})
      current.on('close', (code, reason) => {
        if (stopped || socket !== current) return
        logger.info('OneBot client disconnected (code %d%s)', code, reason.length ? `, ${reason}` : '')
        connection?.dispose()
        connection = undefined
        socket = undefined
        ctx.bot.setStatus('connecting')
      })
      const selfId = req.headers.get('x-self-id')
      if (selfId) ctx.bot.setSelf(selfId, undefined, qqAvatar(selfId))
      connection.login().catch((error) => {
        logger.warn('get_login_info failed: %s', error)
        ctx.bot.setStatus('error', `Connected, but get_login_info failed: ${error.message}`)
      })
    })

    ctx.bot.useTransport({
      send: (channel, segments) => {
        if (!connection) throw new Error('the OneBot client is not connected')
        return connection.send(channel, segments)
      },
      call: (action, params) => {
        if (!connection) throw new Error('the OneBot client is not connected')
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

/** Where the OneBot implementation reaches Mushin in reverse and http modes. */
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
 * HTTP mode: API calls are POSTs to the OneBot HTTP server; the implementation's HTTP client posts events to
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
        if (response.status === 401 || response.status === 403) throw new Error('the OneBot server rejected the access token')
        if (!response.ok) throw new Error(`the OneBot server answered HTTP ${response.status}`)
        return await response.json() as OneBotResponse
      },
      close: () => {},
    }, () => {}, false)

    // Without a lasting connection, "online" means the OneBot server answered get_login_info; keep trying until it does.
    const login = () => {
      if (stopped) return
      if (ctx.bot.status !== 'error') ctx.bot.setStatus('connecting')
      connection.login().catch((error) => {
        if (stopped) return
        logger.warn('cannot reach the OneBot server at %s: %s', base, error.message)
        ctx.bot.setStatus('error', `Cannot reach the OneBot server at ${base}: ${error.message}`)
        retry = setTimeout(login, LOGIN_RETRY)
      })
    }
    logger.info('calling the OneBot server at %s%s; events are posted to %s%s', base, config.token ? ' with a token' : '', path, config.secret ? ' (signed)' : '')
    login()

    ctx.server.post(path, async (req, res) => {
      const body = await req.text()
      if (!signatureMatches(config.secret, body, req.headers.get('x-signature'))) {
        logger.warn('refused an event with a missing or wrong X-Signature; check the secret in the OneBot implementation\'s HTTP client')
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
    ctx.bot.useMediaResolver(onebotMedia(ctx))
    ctx.bot.useContacts(contactList(ctx))
  },
}

const CONTACTS_CACHE_MS = 60_000

/** Friends and groups from the OneBot implementation, kept a minute so switching back to the live view is quick. */
function contactList(ctx: Context) {
  let cache: { at: number; list: Contact[] } | undefined
  return async () => {
    if (cache && Date.now() - cache.at < CONTACTS_CACHE_MS) return cache.list
    const [friends, groups] = await Promise.all([
      ctx.bot.call('get_friend_list', {}).catch(() => []),
      ctx.bot.call('get_group_list', {}).catch(() => []),
    ])
    const list: Contact[] = [
      ...(Array.isArray(groups) ? groups : []).map((group: any): Contact => ({
        type: 'group',
        id: String(group.group_id),
        name: group.group_name || undefined,
        ...(group.member_count ? { members: Number(group.member_count) } : {}),
      })),
      ...(Array.isArray(friends) ? friends : []).map((friend: any): Contact => ({
        type: 'private',
        id: String(friend.user_id),
        name: friend.nickname || friend.remark || undefined,
        ...(friend.remark && friend.nickname && friend.remark !== friend.nickname ? { remark: friend.remark } : {}),
      })),
    ]
    cache = { at: Date.now(), list }
    return list
  }
}

const ROLE_CACHE_MS = 5 * 60_000

/**
 * Group roles for permission checks. Messages carry the sender's role; events do not, so those ask
 * the OneBot implementation (`get_group_member_info`), and the answer is kept a few minutes per group and user.
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
    displayName: 'OneBot v11',
    description: { en: 'Any OneBot 11 implementation, such as a QQ client', 'zh-CN': '任意 OneBot 11 实现，例如 QQ 客户端框架' },
    icon: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2m16 0h2m-7-1v2m-6-2v2"/></g>',
    color: '#5B6CE0',
    config: AdapterConfig,
    secrets: ['token', 'secret'],
    segments: ONEBOT_SEGMENTS,
    groupRoles: true,
    avatars: { user: 'https://q1.qlogo.cn/g?b=qq&nk={id}&s=100', group: 'https://p.qlogo.cn/gh/{id}/{id}/100' },
    hiddenFields: { forward: ['path', 'secret'], reverse: ['url', 'secret'], http: [] },
    plugin: Connection,
    describe: (config, botId) => describeConnection(AdapterConfig.parse(config), botId),
  })
  // Flow nodes for OneBot events and APIs, while the flows plugin is running.
  ctx.inject(['flows'], (ctx) => {
    for (const node of onebotNodes) ctx.flows.defineNode(node)
  })
}
