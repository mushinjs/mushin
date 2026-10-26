import { type ChannelInfo, Context, field, MushinError, randomId, Service, type UserInfo, z } from '@mushin/core'
import { roleAtLeast, type Session } from '@mushin/plugin-bots'
import type { FlowSession, NodeType, PersonaLike } from '@mushin/plugin-flows'
import type {} from '@mushin/plugin-storage'
import { type PersonaExport, personasFrom } from './cards'
import {
  type BotPersonaSettings, DEFAULT_SETTINGS, type Persona, type PersonaInput, personaFields, personaInput, type PersonaReason,
  type PersonaRule, ruleSchema,
} from './types'

export * from './cards'
export * from './types'

declare module '@mushin/core' {
  interface Context {
    personas: Personas
  }

  interface Events {
    'personas/changed'(): void
  }
}

const ITEMS = 'personas/items'
const SETTINGS_KEY = 'personas/bots'
const CHATS_KEY = 'personas/chats'

const chatKey = (channel: Pick<ChannelInfo, 'type' | 'id'>) => `${channel.type}:${channel.id}`

/** Who a persona is picked for. */
export interface PersonaTarget {
  channel: ChannelInfo
  user: UserInfo
  now?: Date
}

export interface PersonaPick {
  persona: Persona
  reason: PersonaReason
  rule?: PersonaRule
}

const pad = (value: number) => String(value).padStart(2, '0')
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Minutes after midnight of `HH:MM`. */
const minutesOf = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

/** Is `now` between `from` and `to`? A range ending before it starts runs past midnight. */
export function inTimeRange(from: string, to: string, now: Date) {
  const start = minutesOf(from)
  const end = minutesOf(to)
  const current = now.getHours() * 60 + now.getMinutes()
  return start <= end ? current >= start && current < end : current >= start || current < end
}

export function ruleMatches(rule: PersonaRule, target: PersonaTarget) {
  const now = target.now ?? new Date()
  switch (rule.when) {
    case 'group': return target.channel.type === 'group' && !!rule.ids?.includes(target.channel.id)
    case 'user': return !!rule.ids?.includes(target.user.id)
    case 'private': return target.channel.type === 'private'
    case 'time': return !!rule.from && !!rule.to && inTimeRange(rule.from, rule.to, now)
  }
}

/** Fills `{bot.name}`, `{user.name}`, `{user.id}`, `{group.id}`, `{time}`, `{date}` and `{weekday}`. */
export function fillVariables(text: string, values: { bot?: string; user?: UserInfo; channel?: ChannelInfo; now?: Date }) {
  const now = values.now ?? new Date()
  const table: Record<string, string> = {
    'bot.name': values.bot ?? '',
    'user.name': values.user?.name ?? values.user?.id ?? '',
    'user.id': values.user?.id ?? '',
    'group.id': values.channel?.type === 'group' ? values.channel.id : '',
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    weekday: WEEKDAYS[now.getDay()],
  }
  return text.replace(/\{(bot\.name|user\.name|user\.id|group\.id|time|date|weekday)\}/g, (_, name: string) => table[name])
}

/**
 * Personas: a character, a voice and example exchanges that LLM replies speak as. Bots pick one
 * per chat (rules by group, user or time; `/persona` switches by hand), the LLM chat plugin and
 * the flows' `ai.chat` use it, and the persona node switches it for one branch of a flow.
 */
export class Personas extends Service {
  static inject = ['bots', 'storage', 'actions']

  private home: Context
  private items = new Map<string, Persona>()
  private settings: Record<string, BotPersonaSettings> = {}
  /** Bot id → chat key → persona switched to with `/persona`. */
  private chats: Record<string, Record<string, string>> = {}

  constructor(ctx: Context) {
    super(ctx, 'personas')
    this.home = ctx
  }

  private get logger() {
    return this.home.logger('personas')
  }

  async *[Service.init]() {
    for (const key of await this.home.storage.list(ITEMS)) {
      const persona = await this.home.storage.get<Persona>(key)
      if (persona?.id) this.items.set(persona.id, persona)
    }
    this.settings = (await this.home.storage.get<Record<string, BotPersonaSettings>>(SETTINGS_KEY)) ?? {}
    this.chats = (await this.home.storage.get<Record<string, Record<string, string>>>(CHATS_KEY)) ?? {}
    this.logger.info('loaded %d persona(s)', this.items.size)
    yield* this.defineActions()
    yield this.home.bots.defineCommand(
      { name: 'persona', description: '查看或切换人格', usage: '[名称|reset]' },
      (session) => this.command(session),
      // Only on bots that have personas to show.
      { bots: (botId) => this.botSettings(botId).command.enabled && this.available(botId).length > 0 },
    )
    // Flows: the persona node, and LLM nodes speaking as the bot's persona.
    this.home.inject(['flows'], (ctx) => {
      ctx.flows.usePersonas({ forRun: (botId, session) => (botId ? this.forSession(botId, session) : undefined) })
      ctx.flows.defineNode(personaNode(this))
    })
  }

  // ---- personas ----

  list() {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string) {
    const persona = this.items.get(id)
    if (!persona) throw new MushinError('not_found', `Persona "${id}" not found`)
    return persona
  }

  /** A persona by id, or by name (any case). */
  find(idOrName: string) {
    const wanted = idOrName.trim().toLowerCase()
    return this.items.get(idOrName) ?? this.list().find((persona) => persona.name.toLowerCase() === wanted)
  }

  async create(input: PersonaInput) {
    const fields = personaInput.parse(input)
    const now = Date.now()
    const persona: Persona = { ...fields, examples: fields.examples ?? [], tags: fields.tags ?? [], id: randomId(6), createdAt: now, updatedAt: now }
    await this.save(persona)
    this.logger.info('created persona "%s"', persona.name)
    return persona
  }

  async update(id: string, patch: Partial<PersonaInput>) {
    const current = this.get(id)
    const fields = personaInput.parse({ ...current, ...patch })
    const persona: Persona = { ...current, ...fields, examples: fields.examples ?? [], tags: fields.tags ?? [], updatedAt: Date.now() }
    await this.save(persona)
    return persona
  }

  async remove(id: string) {
    const persona = this.get(id)
    this.items.delete(id)
    await this.home.storage.delete(`${ITEMS}/${id}`)
    // Bots and chats that used it fall back to their other rules.
    for (const settings of Object.values(this.settings)) {
      settings.personas = settings.personas.filter((item) => item !== id)
      if (settings.default === id) delete settings.default
      settings.rules = settings.rules.filter((rule) => rule.persona !== id)
    }
    for (const chats of Object.values(this.chats)) {
      for (const [key, value] of Object.entries(chats)) if (value === id) delete chats[key]
    }
    await this.home.storage.set(SETTINGS_KEY, this.settings)
    await this.home.storage.set(CHATS_KEY, this.chats)
    this.logger.info('deleted persona "%s"', persona.name)
    this.home.emit('personas/changed')
    return { ok: true }
  }

  private async save(persona: Persona) {
    this.items.set(persona.id, persona)
    await this.home.storage.set(`${ITEMS}/${persona.id}`, persona)
    this.home.emit('personas/changed')
  }

  /** The given personas (every one when none are given), in the format `importAll` reads. */
  exportAll(ids?: string[]): PersonaExport {
    const chosen = ids?.length ? ids.map((id) => this.get(id)) : this.list()
    return {
      format: 'mushin-personas',
      version: 1,
      personas: chosen.map(({ id: _id, createdAt: _created, updatedAt: _updated, ...fields }) => fields),
    }
  }

  /** Adds personas from an export, a persona, a list or character cards. Names already taken get a number. */
  async importAll(data: unknown) {
    const created: Persona[] = []
    const failed: { name: string; error: string }[] = []
    for (const input of personasFrom(data)) {
      const parsed = personaInput.safeParse(input)
      if (!parsed.success) {
        failed.push({ name: String((input as any)?.name ?? '?'), error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') })
        continue
      }
      created.push(await this.create({ ...parsed.data, name: this.freeName(parsed.data.name) }))
    }
    return { created, failed }
  }

  private freeName(name: string) {
    const taken = new Set(this.list().map((persona) => persona.name.toLowerCase()))
    if (!taken.has(name.toLowerCase())) return name
    for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`.toLowerCase())) return `${name} (${n})`
  }

  // ---- bots ----

  botSettings(botId: string): BotPersonaSettings {
    const saved = this.settings[botId]
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      personas: [...saved?.personas ?? []],
      rules: [...saved?.rules ?? []],
      command: { ...DEFAULT_SETTINGS.command, ...saved?.command },
    }
  }

  async updateBotSettings(botId: string, patch: Partial<Omit<BotPersonaSettings, 'rules'>> & { rules?: (Omit<PersonaRule, 'id'> & { id?: string })[] }) {
    this.home.bots.get(botId)
    const next = this.botSettings(botId)
    const known = (id: string) => {
      if (!this.items.has(id)) throw new MushinError('invalid_input', `Persona "${id}" not found`)
      return id
    }
    if (patch.personas) next.personas = [...new Set(patch.personas.map(known))]
    if ('default' in patch) {
      if (patch.default) next.default = known(patch.default)
      else delete next.default
    }
    if (patch.rules) {
      next.rules = patch.rules.map((rule) => {
        known(rule.persona)
        if (rule.when === 'time' && !(rule.from && rule.to)) throw new MushinError('invalid_input', 'Time rules need both from and to (HH:MM)')
        if ((rule.when === 'group' || rule.when === 'user') && !rule.ids?.length) throw new MushinError('invalid_input', `A ${rule.when} rule needs at least one id`)
        return { ...rule, id: rule.id || randomId(4), ...(rule.ids ? { ids: rule.ids.map((id) => id.trim()).filter(Boolean) } : {}) }
      })
    }
    if (patch.command) next.command = { ...next.command, ...patch.command }
    this.settings[botId] = next
    await this.home.storage.set(SETTINGS_KEY, this.settings)
    this.home.emit('personas/changed')
    return next
  }

  /** Personas a bot can speak as: its list, its default and its rules' personas. */
  available(botId: string) {
    const settings = this.botSettings(botId)
    const ids = new Set([...settings.personas, ...(settings.default ? [settings.default] : []), ...settings.rules.map((rule) => rule.persona)])
    return [...ids].flatMap((id) => (this.items.has(id) ? [this.items.get(id)!] : []))
  }

  /** The persona a chat gets on a bot: one switched to with `/persona`, else the first matching rule, else the default. */
  pick(botId: string, target: PersonaTarget): PersonaPick | undefined {
    const switched = this.chats[botId]?.[chatKey(target.channel)]
    if (switched && this.items.has(switched)) return { persona: this.items.get(switched)!, reason: 'chat' }
    const settings = this.botSettings(botId)
    for (const rule of settings.rules) {
      if (this.items.has(rule.persona) && ruleMatches(rule, target)) return { persona: this.items.get(rule.persona)!, reason: 'rule', rule }
    }
    if (settings.default && this.items.has(settings.default)) return { persona: this.items.get(settings.default)!, reason: 'default' }
  }

  /** Switches a chat to a persona, or back to the bot's rules with none. */
  async setChat(botId: string, channel: Pick<ChannelInfo, 'type' | 'id'>, personaId?: string) {
    const chats = this.chats[botId] ??= {}
    if (personaId) chats[chatKey(channel)] = this.get(personaId).id
    else delete chats[chatKey(channel)]
    await this.home.storage.set(CHATS_KEY, this.chats)
    this.home.emit('personas/changed')
  }

  /** Chats of a bot switched to a persona with `/persona`. */
  switchedChats(botId: string) {
    return Object.entries(this.chats[botId] ?? {}).flatMap(([chat, id]) => {
      const persona = this.items.get(id)
      return persona ? [{ chat, persona: { id, name: persona.name } }] : []
    })
  }

  /** A persona with its variables filled in for one message, as LLM nodes and plugins use it. */
  prepare(persona: Persona, values: { botId?: string; user?: UserInfo; channel?: ChannelInfo; now?: Date }): PersonaLike {
    let bot: string | undefined
    try {
      bot = values.botId ? this.home.bots.get(values.botId).name : undefined
    } catch {}
    const fill = (text: string) => fillVariables(text, { bot, user: values.user, channel: values.channel, now: values.now })
    const avoid = persona.avoid?.trim()
    return {
      id: persona.id,
      name: persona.name,
      prompt: fill(avoid ? `${persona.prompt.trim()}\n\nNever do any of these:\n${avoid}` : persona.prompt.trim()),
      examples: persona.examples.map((example) => ({ user: fill(example.user), assistant: fill(example.assistant) })),
      ...(persona.provider ? { provider: persona.provider } : {}),
      ...(persona.model ? { model: persona.model } : {}),
      ...(persona.temperature !== undefined ? { temperature: persona.temperature } : {}),
    }
  }

  /** The persona a message gets on a bot, ready for the LLM; nothing when the bot has none. */
  forSession(botId: string, session: Pick<FlowSession, 'user' | 'channel'>): PersonaLike | undefined {
    const picked = this.pick(botId, { channel: session.channel, user: session.user })
    return picked && this.prepare(picked.persona, { botId, user: session.user, channel: session.channel })
  }

  // ---- /persona ----

  private async command(session: Session) {
    const botId = session.bot.id
    const settings = this.botSettings(botId)
    const arg = session.command?.rest.trim() ?? ''
    const available = this.available(botId)
    const current = this.pick(botId, { channel: session.channel, user: session.user })
    if (!arg) {
      const lines = [
        current ? `当前人格：${current.persona.name}${current.reason === 'chat' ? '（本会话手动切换）' : ''}` : '当前没有使用人格',
        available.length ? `可切换：${available.map((persona) => persona.name).join('、')}` : '这个机器人还没有可切换的人格',
      ]
      if (available.length) lines.push('用法：/persona 名称；/persona reset 恢复默认')
      await session.send(lines.join('\n'))
      return
    }
    if (!roleAtLeast(session.role() ?? 'user', settings.command.role)) {
      await session.send(settings.command.role === 'master' ? '只有主人可以切换人格' : '需要管理员及以上才能切换人格')
      return
    }
    if (/^(reset|default|默认|恢复)$/i.test(arg)) {
      await this.setChat(botId, session.channel)
      const next = this.pick(botId, { channel: session.channel, user: session.user })
      await session.send(next ? `已恢复默认人格：${next.persona.name}` : '已恢复默认，不使用人格')
      return
    }
    const wanted = arg.toLowerCase()
    const persona = available.find((item) => item.id === arg || item.name.toLowerCase() === wanted)
    if (!persona) {
      await session.send(`没有叫“${arg}”的人格。可切换：${available.map((item) => item.name).join('、') || '无'}`)
      return
    }
    await this.setChat(botId, session.channel, persona.id)
    this.logger.info('chat %s on bot %s switched to persona "%s"', chatKey(session.channel), botId, persona.name)
    await session.send(`已切换为：${persona.name}`)
  }

  // ---- actions ----

  private *defineActions() {
    const actions = this.home.actions
    const idInput = z.object({ id: z.string().describe('Persona id from personas.list') })
    const botInput = z.object({ bot: z.string().describe('Bot id from bots.list') })

    yield actions.define({
      name: 'personas.list',
      description: 'List personas: name, description, prompt, example exchanges, preferred model and tags. Bots and flows speak as a persona when their rules or a persona node pick it.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.list(),
    })

    yield actions.define({
      name: 'personas.get',
      description: 'Get one persona.',
      risk: 'read',
      input: idInput,
      handler: ({ id }) => this.get(id),
    })

    yield actions.define({
      name: 'personas.choices',
      description: 'Persona ids and names, for pickers.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.list().map((persona) => ({ value: persona.id, label: persona.name })),
    })

    yield actions.define({
      name: 'personas.create',
      description: 'Create a persona: a name, a system prompt with its character, voice and background, and optionally example exchanges, things to avoid, a preferred provider/model/temperature and tags. The prompt may use {bot.name}, {user.name}, {user.id}, {group.id}, {time}, {date} and {weekday}. Then use it on a bot with personas.updateBotSettings or in a flow with the persona node.',
      risk: 'write',
      input: personaInput,
      handler: (input) => this.create(input),
    })

    yield actions.define({
      name: 'personas.update',
      description: 'Change a persona. Only the fields given change; examples and tags given replace the old lists.',
      risk: 'write',
      input: idInput.extend(z.object(personaFields).partial().shape),
      handler: ({ id, ...patch }) => this.update(id, patch),
    })

    yield actions.define({
      name: 'personas.delete',
      description: 'Delete a persona. Bots and chats that used it fall back to their other rules.',
      risk: 'dangerous',
      input: idInput,
      handler: ({ id }) => this.remove(id),
    })

    yield actions.define({
      name: 'personas.export',
      description: 'Export personas (all when no ids are given) as JSON that personas.import reads.',
      risk: 'read',
      input: z.object({ ids: z.array(z.string()).optional() }),
      handler: ({ ids }) => this.exportAll(ids),
    })

    yield actions.define({
      name: 'personas.import',
      description: 'Import personas from JSON: what personas.export wrote, one persona, a list of them, or SillyTavern-style character cards (v1, v2 or v3 JSON). Names already taken get a number. Returns what was created and what failed.',
      risk: 'write',
      input: z.object({ data: z.any().describe('The parsed JSON') }),
      handler: ({ data }) => this.importAll(data),
    })

    yield actions.define({
      name: 'personas.botSettings',
      description: 'How a bot picks its persona: personas /persona can switch to, the default, rules (first match wins: group ids, user ids, private chats, or a time of day) and who may use /persona. Also lists chats switched by hand.',
      risk: 'read',
      input: botInput,
      handler: ({ bot }) => {
        this.home.bots.get(bot)
        return { ...this.botSettings(bot), chats: this.switchedChats(bot) }
      },
    })

    yield actions.define({
      name: 'personas.updateBotSettings',
      description: 'Change how a bot picks its persona. Lists given replace the old ones; send default as an empty string to remove it. Rules are tried in order, the first match wins, and a chat switched with /persona keeps its persona until reset.',
      risk: 'write',
      input: botInput.extend({
        personas: z.array(z.string()).optional().describe('Persona ids /persona can switch to'),
        default: z.string().optional().describe('Persona id for chats no rule matches; empty for none'),
        rules: z.array(ruleSchema).optional(),
        command: z.object({
          enabled: z.boolean().optional().describe('Answer /persona'),
          role: z.enum(['user', 'admin', 'master']).optional().describe('Who may switch; anyone may list'),
        }).optional(),
      }),
      handler: ({ bot, command, ...patch }) => this.updateBotSettings(bot, {
        ...patch,
        ...(command ? { command: { ...this.botSettings(bot).command, ...command } } : {}),
      }),
    })

    yield actions.define({
      name: 'personas.setChat',
      description: 'Switch one chat of a bot to a persona, as /persona does, or back to the bot\'s rules without a persona id.',
      risk: 'write',
      input: botInput.extend({
        chat: z.string().regex(/^(group|private):\S+$/).describe('"group:<id>" or "private:<user id>"'),
        persona: z.string().optional(),
      }),
      handler: async ({ bot, chat, persona }) => {
        this.home.bots.get(bot)
        const [type, ...rest] = chat.split(':')
        await this.setChat(bot, { type: type as ChannelInfo['type'], id: rest.join(':') }, persona)
        return { ok: true }
      },
    })

    yield actions.define({
      name: 'personas.resolve',
      description: 'Which persona a message would get on a bot, and why (chat switched by hand, a rule, or the default), with the prompt as the model would see it.',
      risk: 'read',
      input: botInput.extend({
        group: z.string().optional().describe('Group id; a private chat when omitted'),
        user: z.string().default('10000'),
        userName: z.string().optional(),
        time: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('Pretend it is this time of day (HH:MM)'),
      }),
      handler: ({ bot, group, user, userName, time }) => {
        this.home.bots.get(bot)
        const now = new Date()
        if (time) now.setHours(Number(time.split(':')[0]), Number(time.split(':')[1]), 0, 0)
        const channel: ChannelInfo = group ? { type: 'group', id: group } : { type: 'private', id: user }
        const target = { channel, user: { id: user, ...(userName ? { name: userName } : {}) }, now }
        const picked = this.pick(bot, target)
        if (!picked) return { persona: null }
        return {
          persona: { id: picked.persona.id, name: picked.persona.name },
          reason: picked.reason,
          ...(picked.rule ? { rule: picked.rule } : {}),
          prepared: this.prepare(picked.persona, { botId: bot, ...target }),
        }
      },
    })
  }
}

export default Personas

/** The persona node: the rest of the run speaks as the chosen persona. */
export function personaNode(personas: Personas): NodeType {
  return {
    kind: 'action',
    type: 'persona.use',
    category: 'ai',
    title: { en: 'Use a persona', 'zh-CN': '使用人格' },
    description: {
      en: 'Later LLM nodes in this run speak as this persona, overriding the bot\'s persona rules. Optionally rewrites fixed reply text in its voice (one extra LLM call per reply).',
      'zh-CN': '本次运行中之后的大模型节点以这个人格说话，覆盖机器人的人格规则。可选：把固定回复文本按人格语气改写（每条回复多一次大模型调用）。',
    },
    config: z.object({
      persona: z.string().default('').meta(field('Persona', 'Empty uses the bot\'s persona rules', {
        'zh-CN': { title: '人格', description: '留空按机器人的人格规则', options: { '': '按机器人规则', none: '不使用人格' } },
      }, { options: { '': 'By the bot\'s rules', none: 'No persona' }, choices: 'personas.choices' })),
      rewrite: z.boolean().default(false).meta(field('Rewrite fixed replies', 'Reply and send nodes after this one rewrite their fixed text in the persona\'s voice. Costs tokens.', {
        'zh-CN': { title: '改写固定回复', description: '之后的回复、发送节点把固定文本按人格语气改写一次，会消耗 Token' },
      }, { widget: 'switch' })),
    }),
    outputs: [{ name: 'name', type: 'text', title: { en: 'Persona name', 'zh-CN': '人格名称' } }],
    async run(context) {
      const { config, session, bot, run } = context
      const id = String(config.persona ?? '').trim()
      if (id === 'none') {
        run.persona = null
        return { outputs: { name: '' } }
      }
      let chosen: PersonaLike | undefined
      if (id) {
        const persona = personas.find(id)
        if (!persona) throw new Error(`Persona "${id}" not found`)
        chosen = personas.prepare(persona, { botId: bot?.id === 'test' ? undefined : bot?.id, user: session.user, channel: session.channel })
      } else {
        chosen = await context.persona()
      }
      run.persona = chosen ? { ...chosen, rewrite: !!config.rewrite } : null
      return { outputs: { name: chosen?.name ?? '' } }
    },
  }
}
