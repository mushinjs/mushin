import type { WebSocket } from 'ws'
import {
  type ActionCaller, Context, type Exporter, field, Logger, LOG_TAGS, type LogTag, logTag, type Message, MushinError, randomId, Service, toErrorPayload, z,
} from '@mushin/core'
import type {} from '@cordisjs/plugin-server'
import type {} from '@mushin/plugin-agent'
import type {} from '@mushin/plugin-bots'
import type {} from '@mushin/plugin-flows'
import type {} from '@mushin/plugin-providers'
import type {} from '@mushin/plugin-stats'
import type {} from '@mushin/plugin-storage'
import { AUTH_KEY, type AuthRecord, generateToken, isAuthRecord, tokensEqual } from './auth'
import { dashboardRoot, MISSING_BUILD_PAGE, readStatic } from './static'

export { readAdminToken, resetAdminToken } from './auth'

declare module '@mushin/core' {
  interface Context {
    console: Console
  }

  interface Events {
    'console/ready'(info: SignInInfo): void
  }
}

/** What the launcher prints so the user can sign in. Never sent through the logger. */
export interface SignInInfo {
  url: string
  token: string
  fromEnv: boolean
}

export const name = 'console'

interface Client {
  id: string
  socket: WebSocket
  authed: boolean
  page?: string
  lastActive: number
  calls: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>
}

export interface LogLine {
  sn: number
  ts: number
  type: string
  name: string
  /** Source category from the logger name, for the dashboard's quick filters. */
  tag: LogTag
  text: string
}

const CLIENT_CALL_TIMEOUT = 15_000
/** Client actions that wait for the user get longer. */
const CLIENT_CALL_TIMEOUTS: Record<string, number> = { 'ui.ask': 15 * 60_000 }

/** Events forwarded to every signed-in dashboard. */
const FORWARDED_EVENTS = [
  'actions/changed', 'manager/changed', 'providers/changed',
  'bots/changed', 'bots/status', 'bots/message', 'bots/log', 'agent/event', 'agent/changed',
  'flows/changed', 'flows/run', 'flows/step', 'flows/tests', 'flows/activity', 'stats/sample', 'permissions/changed', 'personas/changed',
] as const

const plainExporter: Exporter = { colors: false, export() {} }

function formatLog(message: Message): LogLine {
  return {
    sn: message.sn,
    ts: message.ts,
    type: message.type,
    name: message.name,
    tag: logTag(message.name),
    text: Logger.format(plainExporter, message),
  }
}

/**
 * Serves the dashboard, its HTTP API (one generic action endpoint) and a WebSocket for live events.
 * Every request needs the admin token.
 */
export class Console extends Service {
  static inject = ['server', 'actions', 'storage']
  static Config = z.object({
    path: z.string().default('/api').meta(field('API path', 'Base path of the HTTP API', {
      'zh-CN': { title: 'API 路径', description: 'HTTP API 的基础路径' },
    })),
  })

  private home: Context
  private clients = new Map<string, Client>()
  private auth?: AuthRecord
  private reloadedAt = 0
  private envToken = process.env.MUSHIN_ADMIN_TOKEN
  /** Set once the dashboard is being served. */
  ready?: SignInInfo

  constructor(ctx: Context, public config: { path: string }) {
    super(ctx, 'console')
    this.home = ctx
  }

  async *[Service.init]() {
    const devDashboard = process.env.MUSHIN_DEV_DASHBOARD
    await this.ensureToken()
    const { server, actions } = this.home
    const base = this.config.path

    yield actions.setClientRelay((name, input, caller) => this.relay(name, input, caller))
    yield* this.defineActions()

    // Health and login are the only routes that work without a token.
    server.get(`${base}/health`, async (_req, res) => {
      res.json({ ok: true })
    })

    server.post(`${base}/login`, async (req, res) => {
      const body = await readBody(req).catch(() => undefined)
      if (!(await this.authenticate(typeof body?.token === 'string' ? body.token.trim() : undefined))) {
        res.status = 401
        res.json({ ok: false, error: { code: 'unauthorized', message: 'Wrong admin token' } })
        return
      }
      res.json({ ok: true })
    })

    server.get(`${base}/actions`, async (req, res) => {
      if (!(await this.authorize(req, res))) return
      res.json({ ok: true, result: actions.list() })
    })

    server.post(`${base}/actions/:name`, async (req, res) => {
      if (!(await this.authorize(req, res))) return
      try {
        const body = await readBody(req)
        const result = await actions.call(req.params.name, body ?? {}, { kind: 'api' })
        res.json({ ok: true, result: result ?? null })
      } catch (error) {
        res.status = error instanceof MushinError ? error.status : 500
        if (!(error instanceof MushinError)) this.home.logger('console').warn(error)
        res.json({ ok: false, error: toErrorPayload(error) })
      }
    })

    server.ws(`${base}/ws`, async (_req, accept) => {
      this.attach(await accept())
    })

    // Everything outside the API is the dashboard (with SPA fallback).
    const root = dashboardRoot()
    server.get(/^(?!\/api(?:\/|$)).*/, async (req, res) => {
      if (devDashboard) {
        res.status = 302
        res.headers.set('location', `${devDashboard}${req.url}`)
        res.headers.set('cache-control', 'no-store')
        res.text('')
        return
      }
      const file = root ? await readStatic(root, req.path) : undefined
      if (!file) {
        res.headers.set('content-type', 'text/html; charset=utf-8')
        res.status = root ? 404 : 200
        res.text(root ? 'Not found' : MISSING_BUILD_PAGE)
        return
      }
      res.status = 200
      res.headers.set('content-type', file.type)
      res.headers.set('cache-control', file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      res.bytes(new Uint8Array(file.body))
    })

    for (const name of FORWARDED_EVENTS) {
      yield this.home.on(name, (data: unknown) => this.broadcast(name, data))
    }

    // The launcher prints the sign-in link from this event; the token never goes to the log buffer,
    // which the dashboard and the Agent can read.
    this.ready = { url: devDashboard ?? server.baseUrl, token: this.envToken ?? this.auth!.token, fromEnv: !!this.envToken }
    this.home.emit('console/ready', this.ready)
    this.home.logger('console').info('dashboard at %s', this.ready.url)
    yield this.home.logger.exporter({
      colors: false,
      // Lines written inside a bot go to that bot's own log (`bots/log`), not the global one.
      export: (message) => {
        if (!this.isBotLog(message)) this.broadcast('log', formatLog(message))
      },
    })
    yield () => {
      for (const client of this.clients.values()) client.socket.close(1001, 'console stopped')
    }
  }

  private async ensureToken() {
    if (this.envToken) {
      this.home.logger('console').info('using the admin token from MUSHIN_ADMIN_TOKEN')
      return
    }
    const stored = await this.home.storage.get<unknown>(AUTH_KEY)
    if (isAuthRecord(stored)) {
      this.auth = stored
      return
    }
    // No record yet, or one from an older build that kept only a hash: make a token that can be shown.
    this.auth = { token: generateToken(), createdAt: Date.now() }
    await this.home.storage.set(AUTH_KEY, this.auth)
    this.home.logger('console').info(stored ? 'replaced an unreadable admin token record' : 'created the admin token')
  }

  private verify(token: string | null | undefined) {
    return tokensEqual(token, this.envToken ?? this.auth?.token)
  }

  /** Verifies a token; on a miss, re-reads data/auth.json so `mushin token reset` works without a restart. */
  private async authenticate(token: string | null | undefined) {
    if (this.verify(token)) return true
    if (this.envToken || !token || Date.now() - this.reloadedAt < 1000) return false
    this.reloadedAt = Date.now()
    const stored = await this.home.storage.get<unknown>(AUTH_KEY).catch(() => undefined)
    if (!isAuthRecord(stored) || stored.token === this.auth?.token) return false
    this.auth = stored
    if (this.ready) this.ready = { ...this.ready, token: stored.token }
    return this.verify(token)
  }

  private async authorize(req: { headers: Headers }, res: { status: number; json(data: unknown): unknown }) {
    const header = req.headers.get('authorization') ?? ''
    const token = header.replace(/^Bearer\s+/i, '')
    if (await this.authenticate(token)) return true
    res.status = 401
    res.json({ ok: false, error: { code: 'unauthorized', message: 'Sign in with the admin token' } })
    return false
  }

  private isBotLog(message: Message) {
    return this.home.get('bots')?.isBotLog(message) ?? false
  }

  broadcast(name: string, data: unknown) {
    const frame = JSON.stringify({ type: 'event', name, data })
    for (const client of this.clients.values()) {
      if (client.authed && client.socket.readyState === 1) client.socket.send(frame)
    }
  }

  private attach(socket: WebSocket) {
    const client: Client = { id: randomId(), socket, authed: false, lastActive: Date.now(), calls: new Map() }
    this.clients.set(client.id, client)
    const send = (data: unknown) => socket.readyState === 1 && socket.send(JSON.stringify(data))
    const authTimer = setTimeout(() => {
      if (!client.authed) socket.close(4401, 'authentication timeout')
    }, 10_000)

    socket.on('close', () => {
      clearTimeout(authTimer)
      this.clients.delete(client.id)
      for (const call of client.calls.values()) {
        clearTimeout(call.timer)
        call.reject(new MushinError('unavailable', 'The dashboard tab was closed'))
      }
    })

    // Messages can arrive while the token is still being checked (the tab reports its page as soon
    // as the socket opens); they wait for the check instead of failing it.
    let authenticating: Promise<boolean> | undefined
    socket.on('message', async (raw) => {
      let message: any
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      client.lastActive = Date.now()
      if (!client.authed) {
        if (message.type === 'auth' && !authenticating) {
          authenticating = this.authenticate(message.token)
          if (await authenticating) {
            client.authed = true
            client.page = message.page
            clearTimeout(authTimer)
            send({ type: 'ready', client: client.id })
          } else {
            socket.close(4401, 'wrong admin token')
          }
          return
        }
        if (!authenticating) {
          socket.close(4401, 'authenticate first')
          return
        }
        if (!await authenticating) return
      }
      switch (message.type) {
        case 'page':
          client.page = typeof message.path === 'string' ? message.path : undefined
          return
        case 'call': {
          const caller: ActionCaller = { kind: 'api', client: client.id }
          try {
            const input = message.action === 'agent.send' ? { page: client.page, ...message.input } : message.input
            const result = await this.home.actions.call(String(message.action), input ?? {}, caller)
            send({ type: 'result', id: message.id, ok: true, result: result ?? null })
          } catch (error) {
            send({ type: 'result', id: message.id, ok: false, error: toErrorPayload(error) })
          }
          return
        }
        case 'client-result': {
          const call = client.calls.get(String(message.id))
          if (!call) return
          client.calls.delete(String(message.id))
          clearTimeout(call.timer)
          if (message.ok) call.resolve(message.result ?? { ok: true })
          else call.reject(new MushinError('failed', message.error?.message ?? 'The dashboard could not run this action'))
        }
      }
    })
  }

  /** Runs a client action in the caller's dashboard tab, or the most recently active one. */
  private relay(name: string, input: unknown, caller: ActionCaller) {
    let client = caller.client ? this.clients.get(caller.client) : undefined
    if (!client?.authed) {
      client = [...this.clients.values()].filter((item) => item.authed).sort((a, b) => b.lastActive - a.lastActive)[0]
    }
    if (!client) return Promise.reject(new MushinError('unavailable', 'No dashboard is open'))
    const target = client
    const id = randomId()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        target.calls.delete(id)
        reject(new MushinError('unavailable', 'The dashboard did not answer'))
      }, CLIENT_CALL_TIMEOUTS[name] ?? CLIENT_CALL_TIMEOUT)
      target.calls.set(id, { resolve, reject, timer })
      target.socket.send(JSON.stringify({ type: 'client-call', id, action: name, input }))
    })
  }

  private *defineActions() {
    const actions = this.home.actions

    yield actions.define({
      name: 'ui.navigate',
      description: 'Open a dashboard page in the user\'s browser, e.g. /bots/<bot id>, /flows/<flow id> or /providers.',
      risk: 'read',
      client: true,
      input: z.object({ path: z.string().regex(/^\//).describe('Dashboard path starting with /') }),
    })

    yield actions.define({
      name: 'ui.highlight',
      description: 'Point at a control on the current dashboard page. Targets: providers.add, bots.add, bot.connection, bot.plugins, bot.live, bot.logs, flows.add, flows.bots, flows.save, flows.test, agent.input.',
      risk: 'read',
      client: true,
      input: z.object({
        target: z.string().describe('Highlight target id'),
        message: z.string().optional().describe('Short hint shown next to the control'),
      }),
    })

    yield actions.define({
      name: 'ui.ask',
      description: 'Ask the user a multiple-choice question in the Agent panel and wait for the answer. Use it when a choice is theirs to make (which bot, which provider, whether to overwrite). Returns { choice, label } or { other } when they type their own answer.',
      risk: 'read',
      client: true,
      input: z.object({
        question: z.string().min(1).max(300),
        options: z.array(z.object({
          label: z.string().min(1).max(80),
          description: z.string().max(200).optional(),
        })).min(2).max(6),
        recommended: z.number().int().min(0).optional().describe('Index of the option you recommend'),
        allowOther: z.boolean().optional().describe('Let the user type their own answer'),
      }),
    })

    yield actions.define({
      name: 'system.info',
      description: 'Server address and runtime versions. The address is what NapCat should use in reverse mode.',
      risk: 'read',
      input: z.object({}),
      handler: () => ({
        baseUrl: this.home.server.baseUrl,
        node: process.version,
        platform: process.platform,
        uptime: Math.round(process.uptime()),
      }),
    })

    yield actions.define({
      name: 'logs.recent',
      description: 'Recent log lines of Mushin.js itself, oldest first, each with a source tag. Lines written inside a bot are in bots.logs instead.',
      risk: 'read',
      input: z.object({
        limit: z.number().int().min(1).max(1000).optional(),
        tag: z.enum(LOG_TAGS).optional().describe('Only lines from this source: plugin, bot, adapter, flow, provider, agent, system or other'),
      }),
      handler: ({ limit, tag }) => this.home.logger.buffer
        .filter((message) => !this.isBotLog(message) && (!tag || logTag(message.name) === tag))
        .slice(-(limit ?? 200))
        .map(formatLog),
    })
  }
}

async function readBody(req: { text(): Promise<string> }) {
  const text = await req.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new MushinError('invalid_input', 'Request body must be JSON')
  }
}

export default Console
