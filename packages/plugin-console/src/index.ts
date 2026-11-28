import type { WebSocket } from 'ws'
import {
  type ActionCaller, Context, type Exporter, field, Logger, LOG_TAGS, type LogTag, logTag, type Message, MushinError, randomId, Service, toErrorPayload, z,
} from '@mushinjs/core'
import type {} from '@cordisjs/plugin-server'
import type {} from '@mushinjs/plugin-fairy'
import type {} from '@mushinjs/plugin-bots'
import type {} from '@mushinjs/plugin-flows'
import type {} from '@mushinjs/plugin-providers'
import type {} from '@mushinjs/plugin-stats'
import type {} from '@mushinjs/plugin-storage'
import { ADMIN_TOKEN_ENV, AUTH_KEY, generateToken, isAuthRecord, tokensEqual } from './auth'
import { McpServer, mcpConfigFields } from './mcp'
import { dashboardRoot, MISSING_BUILD_PAGE, readStatic } from './static'

export { ADMIN_TOKEN_ENV, readAdminToken, resetAdminToken } from './auth'
export { CALL_TOOL, DEFAULT_TOOLS, MCP_PATH, McpServer, PROTOCOL_VERSIONS, SEARCH_TOOL } from './mcp'

declare module '@mushinjs/core' {
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
  /** The tab asked for debug lines on its log page (a `logs` message). */
  debugLogs?: boolean
  lastActive: number
  calls: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
type LogLevel = typeof LOG_LEVELS[number]
const LOG_LEVEL_DEBUG = 3
const DEBUG_BUFFER_SIZE = 1000

export interface LogLine {
  sn: number
  ts: number
  type: string
  name: string
  /** Source category from the logger name, for the dashboard's quick filters. */
  tag: LogTag
  /** The app plugin that wrote it, when the line comes from a plugin's code. */
  plugin?: string
  text: string
}

const CLIENT_CALL_TIMEOUT = 15_000
/** Client actions that wait for the user get longer. */
const CLIENT_CALL_TIMEOUTS: Record<string, number> = { 'ui.ask': 15 * 60_000 }

/** Events forwarded to every signed-in dashboard. */
const FORWARDED_EVENTS = [
  'actions/changed', 'manager/changed', 'providers/changed',
  'bots/changed', 'bots/status', 'bots/message', 'bots/log', 'fairy/event', 'fairy/changed', 'fairy/sessions',
  'flows/changed', 'flows/run', 'flows/step', 'flows/tests', 'flows/activity', 'flows/paused', 'stats/sample', 'permissions/changed', 'personas/changed',
  'knowledge/changed', 'knowledge/progress', 'terminal/process', 'terminal/output', 'browser/frame', 'browser/closed', 'bots/run',
] as const

const plainExporter: Exporter = { colors: false, export() {} }

function formatLog(message: Message, plugin?: string): LogLine {
  return {
    sn: message.sn,
    ts: message.ts,
    type: message.type,
    name: message.name,
    tag: logTag(message.name),
    ...(plugin ? { plugin } : {}),
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
    ...mcpConfigFields,
  })

  private home: Context
  private clients = new Map<string, Client>()
  /**
   * Recent debug lines. The logger's own buffer keeps info and above; debug lines are kept here and sent
   * only to the tabs that turned them on.
   */
  private debugBuffer: Message[] = []
  /** The token in .env. */
  private token?: string
  private reloadedAt = 0
  /** A token set in the shell, which overrides .env and cannot be reset. */
  private envToken?: string
  /** Set once the dashboard is being served. */
  ready?: SignInInfo

  constructor(ctx: Context, public config: { path: string; mcp: boolean; mcpTools: string[]; mcpAll: boolean }) {
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

    if (this.config.mcp !== false) {
      new McpServer(this.home, { tools: this.config.mcpTools ?? [], all: !!this.config.mcpAll }, (token) => this.authenticate(token)).serve()
    }

    // Everything outside the API and the MCP endpoint is the dashboard (with SPA fallback).
    const root = dashboardRoot()
    server.get(/^(?!\/(?:api|mcp)(?:\/|$)).*/, async (req, res) => {
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
    // which the dashboard and Fairy can read.
    this.ready = { url: devDashboard ?? server.baseUrl, token: this.envToken ?? this.token!, fromEnv: !!this.envToken }
    this.home.emit('console/ready', this.ready)
    this.home.logger('console').info('dashboard at %s', this.ready.url)
    yield this.home.logger.exporter({
      colors: false,
      levels: { default: LOG_LEVEL_DEBUG },
      // Lines written inside a bot go to that bot's own log (`bots/log`), not the global one.
      export: (message) => {
        if (this.isBotLog(message)) return
        if (message.type !== 'debug') return this.broadcast('log', this.format(message))
        this.debugBuffer.push(message)
        if (this.debugBuffer.length > DEBUG_BUFFER_SIZE) this.debugBuffer.splice(0, this.debugBuffer.length - DEBUG_BUFFER_SIZE)
        if ([...this.clients.values()].some((client) => client.debugLogs)) {
          this.broadcast('log', this.format(message), (client) => !!client.debugLogs)
        }
      },
    })
    yield () => {
      for (const client of this.clients.values()) client.socket.close(1001, 'console stopped')
    }
  }

  private async ensureToken() {
    const { storage } = this.home
    const logger = this.home.logger('console')
    if (storage.secrets.fromShell(ADMIN_TOKEN_ENV)) {
      this.envToken = process.env[ADMIN_TOKEN_ENV]
      logger.info('using the admin token from %s', ADMIN_TOKEN_ENV)
      return
    }
    // Older versions kept the token in data/core/auth.json (or only a hash of it, which cannot be shown).
    const legacy = await storage.get<unknown>(AUTH_KEY).catch(() => undefined)
    this.token = storage.secrets.get(ADMIN_TOKEN_ENV) || undefined
    if (!this.token) {
      this.token = isAuthRecord(legacy) ? legacy.token : generateToken()
      await storage.secrets.set(ADMIN_TOKEN_ENV, this.token)
      logger.info(isAuthRecord(legacy) ? 'moved the admin token to .env' : 'created the admin token in .env')
    }
    if (legacy !== undefined) await storage.delete(AUTH_KEY)
  }

  private verify(token: string | null | undefined) {
    return tokensEqual(token, this.envToken ?? this.token)
  }

  /** Verifies a token; on a miss, re-reads .env so `mushin token reset` works without a restart. */
  async authenticate(token: string | null | undefined) {
    if (this.verify(token)) return true
    if (this.envToken || !token || Date.now() - this.reloadedAt < 1000) return false
    this.reloadedAt = Date.now()
    const { secrets } = this.home.storage
    await secrets.reload().catch(() => {})
    const stored = secrets.get(ADMIN_TOKEN_ENV)
    if (!stored || stored === this.token) return false
    this.token = stored
    if (this.ready) this.ready = { ...this.ready, token: stored }
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

  broadcast(name: string, data: unknown, to?: (client: Client) => boolean) {
    const frame = JSON.stringify({ type: 'event', name, data })
    for (const client of this.clients.values()) {
      if (client.authed && client.socket.readyState === 1 && (!to || to(client))) client.socket.send(frame)
    }
  }

  /** Recent lines of the global log, oldest first; debug lines only when `level` is debug. */
  /** A log line for the dashboard, with the plugin that wrote it. */
  private format(message: Message) {
    return formatLog(message, this.home.get('manager')?.packageOf(message.fiber?.deref()))
  }

  recentLogs(options: { limit?: number; tag?: LogTag; level?: LogLevel; plugin?: string } = {}) {
    const min = LOG_LEVELS.indexOf(options.level ?? 'info')
    let messages = this.home.logger.buffer
    if (min === 0 && this.debugBuffer.length) {
      // Debug lines older than the oldest line of a full buffer would leave a gap in the other levels.
      const full = messages.length >= this.home.logger.bufferSize
      const from = full ? messages[0]?.sn ?? 0 : 0
      messages = [...messages, ...this.debugBuffer.filter((message) => message.sn >= from)].sort((a, b) => a.sn - b.sn)
    }
    return messages
      .filter((message) => !this.isBotLog(message)
        && LOG_LEVELS.indexOf(message.type) >= min
        && (!options.tag || logTag(message.name) === options.tag))
      .map((message) => this.format(message))
      .filter((line) => !options.plugin || line.plugin === options.plugin)
      .slice(-(options.limit ?? 200))
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
        case 'logs':
          // The Logs page's "Show debug logs" switch; only this tab starts getting debug lines.
          client.debugLogs = message.debug === true
          return
        case 'call': {
          const caller: ActionCaller = { kind: 'api', client: client.id }
          try {
            const input = message.action === 'fairy.send' ? { page: client.page, ...message.input } : message.input
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
      // The Fairy conversation that made the call, so the dashboard answers in the right pane.
      target.socket.send(JSON.stringify({ type: 'client-call', id, action: name, input, ...(caller.session ? { session: caller.session } : {}) }))
    })
  }

  private *defineActions() {
    const actions = this.home.actions

    yield actions.define({
      name: 'ui.navigate',
      description: 'Offer a dashboard page, e.g. /bots/<bot id>, /flows/<flow id> or /providers. The dashboard shows it in the chat as a card the user opens when they want, so their page stays put; with asked it opens the page at once.',
      risk: 'read',
      client: true,
      input: z.object({
        path: z.string().regex(/^\//).describe('Dashboard path starting with /'),
        asked: z.boolean().optional().describe('True only when the user asked in their last message to be taken to this page'),
      }),
    })

    yield actions.define({
      name: 'ui.panel',
      description: 'Show something in the side panel of the Fairy workspace, next to the chat: a dashboard page (page, with a path such as /bots/<bot id>/logs, /flows/<flow id>, /plugins or /database), a web page (web, with a url), the status of bots and plugins (status), the commands run on this machine with their live output (terminal), or the browser you use with browser__* tools (browser). Use it to show what you are working on or what the user asked to see. Fails when the user is not in the Fairy workspace; then use ui.navigate.',
      risk: 'read',
      client: true,
      input: z.object({
        kind: z.enum(['page', 'web', 'status', 'terminal', 'browser']),
        path: z.string().regex(/^\//).optional().describe('For page: dashboard path starting with /'),
        url: z.string().regex(/^https?:\/\//).optional().describe('For web: an http or https address'),
        title: z.string().max(60).optional().describe('Tab title; the page name when omitted'),
      }).refine((input) => input.kind !== 'page' || input.path, 'A page needs a path').refine((input) => input.kind !== 'web' || input.url, 'A web page needs a url'),
    })

    yield actions.define({
      name: 'ui.highlight',
      description: 'Point at a control on the current dashboard page. Targets: providers.add, bots.add, bot.connection, bot.plugins, bot.runs, bot.live, bot.logs, flows.add, flows.bots, flows.save, flows.test, fairy.input.',
      risk: 'read',
      client: true,
      input: z.object({
        target: z.string().describe('Highlight target id'),
        message: z.string().optional().describe('Short hint shown next to the control'),
        asked: z.boolean().optional().describe('True when the user asked where the control is; the page then scrolls to it. Otherwise it is pointed at only if it is on screen, and the chat offers to show it'),
      }),
    })

    yield actions.define({
      name: 'ui.ask',
      description: 'Ask the user a multiple-choice question in the Fairy panel and wait for the answer. Use it when a choice is theirs to make (which bot, which provider, whether to overwrite). Returns { choice, label } or { other } when they type their own answer.',
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
      description: 'Server address and runtime versions. The address is what a OneBot implementation should use in reverse mode.',
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
        tag: z.enum(LOG_TAGS).optional().describe('Only lines from this source: plugin, bot, adapter, flow, provider, fairy, system or other'),
        level: z.enum(LOG_LEVELS).optional().describe('This level and above; default info. debug adds the debug lines, which are kept only for a short while'),
        plugin: z.string().optional().describe('Only lines written by this app plugin package'),
      }),
      handler: (input) => this.recentLogs(input),
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
