import { createHash, timingSafeEqual } from 'node:crypto'
import { type ChannelInfo, type Context, field, type Segment, z } from '@mushinjs/core'
import { type GroupRole, mediaSource } from '@mushinjs/plugin-bots'
import type {} from '@cordisjs/plugin-server'
import { TelegramApi, TelegramError } from './api'
import { buildText, decodeEvents, decodeMessage, type SelfInfo, TELEGRAM_SEGMENTS } from './message'

export * from './api'
export * from './message'

export const name = 'adapter-telegram'
export const inject = ['bots']

export const AdapterConfig = z.object({
  mode: z.enum(['polling', 'webhook']).default('polling').meta(field(
    'Connection mode',
    'polling: Mushin asks Telegram for updates; works without a public address. webhook: Telegram posts updates to Mushin, which needs a public HTTPS address.',
    { 'zh-CN': { title: '接入方式', description: 'polling（长轮询）：Mushin 向 Telegram 拉取更新，不需要公网地址。webhook：Telegram 把更新推送到 Mushin，需要公网 HTTPS 地址。' } },
  )),
  token: z.string().default('').meta(field(
    'Bot token',
    'The token @BotFather gave, like 123456:ABC-DEF…',
    { 'zh-CN': { title: '机器人令牌', description: '@BotFather 给出的令牌，形如 123456:ABC-DEF…' } },
  )),
  endpoint: z.string().regex(/^(https?:\/\/.+)?$/, 'must start with http:// or https://').default('').meta(field(
    'API address',
    'Leave empty for https://api.telegram.org. Set it to a self-hosted Bot API server or a reverse proxy when api.telegram.org cannot be reached.',
    { 'zh-CN': { title: 'API 地址', description: '留空则为 https://api.telegram.org。无法访问 api.telegram.org 时，可填自建的 Bot API 服务器或反向代理地址。' } },
  )),
  publicUrl: z.string().regex(/^(https:\/\/.+)?$/, 'must start with https://').default('').meta(field(
    'Public address',
    'webhook mode: the HTTPS address the internet reaches Mushin at, e.g. https://bot.example.com. Mushin registers <public address><path> with Telegram.',
    { 'zh-CN': { title: '公网地址', description: 'webhook 模式：外网访问 Mushin 的 HTTPS 地址，例如 https://bot.example.com。Mushin 会向 Telegram 登记 <公网地址><路径>。' } },
  )),
  path: z.string().regex(/^(\/[\w.~-]*)*$/, 'must be a path such as /telegram/mybot').default('').meta(field(
    'Webhook path',
    'Path Telegram posts updates to; empty means /telegram/<bot id>',
    { 'zh-CN': { title: 'Webhook 路径', description: 'Telegram 推送更新的路径；留空则为 /telegram/<机器人 id>' } },
  )),
})

export type AdapterConfig = z.infer<typeof AdapterConfig>

/** Updates Mushin asks for; `chat_member` is only sent when asked for by name. */
const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member', 'chat_member', 'chat_join_request']
const POLL_TIMEOUT = 25
const RETRY_MIN = 1_000
const RETRY_MAX = 60_000
const LOGIN_RETRY = 30_000
const ROLE_CACHE_MS = 5 * 60_000
const CAPTION_LIMIT = 1024

/** Where Telegram posts updates in webhook mode. */
const inboundPath = (config: AdapterConfig, botId: string) => config.path || `/telegram/${botId}`

/** The webhook's secret token: derived from the bot token, so it needs no setting and changes with it. */
export function webhookSecret(token: string) {
  return createHash('sha256').update(`mushin-telegram:${token}`).digest('hex')
}

/** Explains the errors a person can fix. */
function explain(error: unknown) {
  if (error instanceof TelegramError) {
    if (error.code === 401 || error.code === 404) return 'Telegram refused the bot token; copy it again from @BotFather'
    if (error.code === 409) return `another program is receiving this bot's updates (${error.description})`
    return error.description
  }
  const cause = (error as any)?.cause
  return `${(error as Error)?.message ?? error}${cause?.code ? ` (${cause.code})` : ''}`
}

class TelegramBot {
  self?: SelfInfo
  /** The forum topic each chat last wrote in, so answers land in the same topic. */
  private topics = new Map<string, number>()
  private roles = new Map<string, { role: GroupRole | undefined; at: number }>()
  private logger

  constructor(private ctx: Context, public api: TelegramApi) {
    this.logger = ctx.logger('telegram')
  }

  async login() {
    const me = await this.api.call('getMe')
    const name = [me.first_name, me.last_name].filter(Boolean).join(' ') || me.username
    this.self = { id: String(me.id), username: me.username, name }
    this.ctx.bot.setSelf(String(me.id), name)
    // Opens Telegram (the app, when installed) to pick a group to add the bot to.
    this.ctx.bot.setInvite(me.username ? `https://t.me/${me.username}?startgroup=true` : undefined)
    this.logger.info('logged in as %s (@%s, %s)', name, me.username ?? '?', me.id)
  }

  handle(update: any) {
    if (!this.self) return
    const message = update.message
    const incoming = decodeMessage(message, this.self)
    if (incoming) {
      if (message.from?.id && String(message.from.id) === this.self.id) return
      const chat = String(message.chat.id)
      if (message.is_topic_message && message.message_thread_id) this.topics.set(chat, message.message_thread_id)
      else this.topics.delete(chat)
      this.ctx.bot.receive(incoming).catch((error) => this.logger.warn('failed to handle message: %s', error))
      return
    }
    for (const event of decodeEvents(update)) this.ctx.bot.dispatchEvent(event)
  }

  /** Sends text and media; a single picture or file carries the text as its caption. */
  async send(channel: ChannelInfo, segments: Segment[]) {
    const chatId = channel.id
    const replyId = segments.find((item) => item.type === 'reply')?.data.id
    const media = segments.filter((item) => ['image', 'record', 'video', 'file'].includes(item.type))
    const { text, entities } = buildText(segments)
    const thread = this.topics.get(chatId)
    const common = {
      chat_id: chatId,
      ...(thread ? { message_thread_id: thread } : {}),
      ...(replyId ? { reply_parameters: { message_id: Number(replyId), allow_sending_without_reply: true } } : {}),
    }
    const ids: string[] = []
    let caption = text.trim() && text.length <= CAPTION_LIMIT && media.length ? { caption: text, caption_entities: entities } : undefined
    if (text.trim() && !caption) {
      const sent = await this.api.callRetrying('sendMessage', { ...common, text, entities })
      ids.push(String(sent.message_id))
    }
    for (const item of media) {
      const sent = await this.sendMedia(item, { ...common, ...(caption ?? {}) })
      ids.push(String(sent.message_id))
      caption = undefined
    }
    return { messageId: ids[0] }
  }

  private async sendMedia(segment: Segment, params: Record<string, any>) {
    const source = segment.data.file_id ? undefined : await mediaSource(segment)
    const name = String(segment.data.name ?? (source?.kind === 'bytes' ? source.name : '') ?? '')
    const mime = source?.kind === 'bytes' ? source.mime : ''
    const [method, field] = segment.type === 'image'
      ? (/\.gif$/i.test(name) || mime === 'image/gif' ? ['sendAnimation', 'animation'] : ['sendPhoto', 'photo'])
      : segment.type === 'video' ? ['sendVideo', 'video']
      : segment.type === 'record' ? (mime === 'audio/ogg' || /\.(ogg|oga|opus)$/i.test(name) ? ['sendVoice', 'voice'] : ['sendAudio', 'audio'])
      : ['sendDocument', 'document']
    if (!source || source.kind === 'url') {
      return this.api.callRetrying(method, { ...params, [field]: segment.data.file_id ?? (source as any).url })
    }
    const form = new FormData()
    for (const [key, value] of Object.entries(params)) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    form.set(field, new Blob([new Uint8Array(source.bytes)], { type: source.mime }), source.name)
    return this.api.callRetrying(method, form)
  }

  /** A member's group role from `getChatMember`, kept a few minutes. */
  async roleOf(chatId: string, userId: string): Promise<GroupRole | undefined> {
    const key = `${chatId}|${userId}`
    const hit = this.roles.get(key)
    if (hit && Date.now() - hit.at < ROLE_CACHE_MS) return hit.role
    const member = await this.api.call('getChatMember', { chat_id: chatId, user_id: Number(userId) })
    const role: GroupRole | undefined = member.status === 'creator' ? 'owner' : member.status === 'administrator' ? 'admin'
      : member.status === 'member' || member.status === 'restricted' ? 'member' : undefined
    this.roles.set(key, { role, at: Date.now() })
    if (this.roles.size > 2000) this.roles.delete(this.roles.keys().next().value!)
    return role
  }

  /** A file as a data URL: its download address holds the bot token, so it is never handed out. */
  async media(segment: Segment) {
    const fileId = segment.data.file_id ?? segment.data.file
    if (!fileId || /^https?:\/\//.test(fileId)) return fileId ? { url: String(fileId) } : undefined
    const file = await this.api.download(String(fileId))
    const type = file.type && file.type !== 'application/octet-stream' ? file.type.split(';')[0]
      : segment.type === 'image' ? (/\.webp$/i.test(file.path) ? 'image/webp' : 'image/jpeg') : 'application/octet-stream'
    return { url: `data:${type};base64,${file.bytes.toString('base64')}`, name: segment.data.name ?? file.path.split('/').pop(), size: file.bytes.length }
  }
}

/** Long polling: `getUpdates` waits up to 25 seconds for updates; errors back off up to a minute. */
function startPolling(ctx: Context, bot: TelegramBot) {
  const logger = ctx.logger('telegram')
  const abort = new AbortController()
  let offset: number | undefined
  let delay = RETRY_MIN

  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    abort.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })

  const fail = async (error: unknown, what: string) => {
    if (abort.signal.aborted) return
    const reason = explain(error)
    logger.warn('%s: %s', what, reason)
    ctx.bot.setStatus('error', `${what}: ${reason}`)
    logger.info('retrying in %ds', Math.round(delay / 1000))
    await sleep(delay)
    delay = Math.min(delay * 2, RETRY_MAX)
  }

  const run = async () => {
    while (!abort.signal.aborted) {
      try {
        ctx.bot.setStatus('connecting')
        await bot.login()
        // Updates cannot be polled while a webhook is set, e.g. after switching from webhook mode.
        await bot.api.call('deleteWebhook', { drop_pending_updates: false })
        break
      } catch (error) {
        await fail(error, 'Cannot reach Telegram')
      }
    }
    if (abort.signal.aborted) return
    ctx.bot.setStatus('online')
    while (!abort.signal.aborted) {
      try {
        const updates = await bot.api.call<any[]>('getUpdates', { timeout: POLL_TIMEOUT, allowed_updates: ALLOWED_UPDATES, ...(offset !== undefined ? { offset } : {}) }, {
          timeout: (POLL_TIMEOUT + 10) * 1000,
          signal: abort.signal,
        })
        if (ctx.bot.status !== 'online') {
          logger.info('receiving updates again')
          ctx.bot.setStatus('online')
        }
        delay = RETRY_MIN
        for (const update of updates) {
          offset = update.update_id + 1
          try {
            bot.handle(update)
          } catch (error) {
            logger.warn('failed to handle update %d: %s', update.update_id, error)
          }
        }
      } catch (error) {
        await fail(error, 'Getting updates failed')
      }
    }
  }

  run()
  ctx.effect(() => () => abort.abort(), 'telegram polling')
}

/** Webhook: registers `<public address><path>` with a secret token, then takes posted updates. */
function startWebhook(ctx: Context, config: AdapterConfig, bot: TelegramBot, token: string) {
  const logger = ctx.logger('telegram')
  const path = inboundPath(config, ctx.bot.id)
  const secret = webhookSecret(token)
  let stopped = false
  let retry: NodeJS.Timeout | undefined

  if (!config.publicUrl) {
    ctx.bot.setStatus('error', 'Webhook mode needs the public address Telegram can reach Mushin at')
    return
  }
  const url = `${config.publicUrl.replace(/\/+$/, '')}${path}`

  const register = async () => {
    if (stopped) return
    ctx.bot.setStatus('connecting')
    try {
      await bot.login()
      await bot.api.call('setWebhook', { url, secret_token: secret, allowed_updates: ALLOWED_UPDATES })
      if (stopped) return
      logger.info('registered the webhook %s', url)
      ctx.bot.setStatus('online')
    } catch (error) {
      if (stopped) return
      const reason = explain(error)
      logger.warn('cannot register the webhook: %s', reason)
      ctx.bot.setStatus('error', `Cannot register the webhook: ${reason}`)
      retry = setTimeout(register, LOGIN_RETRY)
    }
  }
  register()

  ctx.server.post(path, async (req, res) => {
    const supplied = Buffer.from(req.headers.get('x-telegram-bot-api-secret-token') ?? '')
    if (supplied.length !== secret.length || !timingSafeEqual(supplied, Buffer.from(secret))) {
      logger.warn('refused an update without the webhook\'s secret token')
      res.status = 401
      res.json({ error: 'bad secret token' })
      return
    }
    let update: any
    try {
      update = JSON.parse(await req.text())
    } catch {
      res.status = 400
      res.json({ error: 'not JSON' })
      return
    }
    res.status = 200
    res.json({})
    try {
      bot.handle(update)
    } catch (error) {
      logger.warn('failed to handle update %s: %s', update?.update_id, error)
    }
  })

  ctx.effect(() => () => {
    stopped = true
    clearTimeout(retry)
  }, 'telegram webhook')
}

/** Loaded inside each bot's context; picks long polling or webhook from the bot's adapter config. */
const Connection = {
  name: 'telegram',
  inject: ['bot'],
  Config: AdapterConfig,
  apply(ctx: Context, config: AdapterConfig) {
    const api = new TelegramApi(config.token, config.endpoint)
    const bot = new TelegramBot(ctx, api)
    if (config.mode === 'webhook') ctx.inject(['server'], (ctx) => startWebhook(ctx, config, bot, config.token))
    else startPolling(ctx, bot)
    ctx.bot.useTransport({
      send: (channel, segments) => bot.send(channel, segments),
      call: (method, params) => api.call(method, params),
    })
    ctx.bot.useRoleResolver(({ channel, user }) => bot.roleOf(channel.id, user.id))
    ctx.bot.useMediaResolver({ media: (segment) => bot.media(segment) })
  },
}

function describeConnection(config: AdapterConfig, botId: string) {
  if (config.mode === 'webhook') return { mode: 'webhook', inbound: inboundPath(config, botId), ...(config.publicUrl ? { address: config.publicUrl } : {}) }
  return { mode: 'polling', address: new URL(config.endpoint || 'https://api.telegram.org').host }
}

export function apply(ctx: Context) {
  ctx.bots.defineAdapter({
    id: 'telegram',
    displayName: 'Telegram',
    config: AdapterConfig,
    secrets: ['token'],
    segments: TELEGRAM_SEGMENTS,
    groupRoles: true,
    hiddenFields: { polling: ['publicUrl', 'path'], webhook: [] },
    links: [{ url: 'https://t.me/BotFather', label: { en: 'Open @BotFather', 'zh-CN': '打开 @BotFather' } }],
    plugin: Connection,
    describe: (config, botId) => describeConnection(AdapterConfig.parse(config), botId),
  })
}
