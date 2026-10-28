import { type ChannelInfo, Context, field, MushinError, Service, type UserInfo, z } from '@mushin/core'
import { type BotRole, type GroupRole, roleAtLeast, type Session } from '@mushin/plugin-bots'
import type { FlowSession, NodeType } from '@mushin/plugin-flows'
import type {} from '@mushin/plugin-storage'
import { applyMemberAction, channelKey, type ChatMember, type ChatMemberPatch, ChatStore, type MemberAction, memberNodes, RuleInput } from './chats'

export * from './chats'

declare module '@mushin/core' {
  interface Context {
    permissions: Permissions
  }

  interface Events {
    'permissions/changed'(botId: string): void
  }
}

/** Masters and admins of one bot. Everyone else is a user. */
export interface BotPermissions {
  masters: string[]
  admins: string[]
  /** Chat commands such as `/拉黑 @someone` for managing chat members; needs the database. */
  chatCommands?: boolean
}

interface StoredPermissions {
  bots: Record<string, BotPermissions>
  /** Bots whose old command admins (`commands.admins`) were moved here. */
  migrated?: string[]
}

/** What a permission check allows: bot roles (higher roles pass too) and group roles. */
export type Allowed = 'master' | 'admin' | 'user' | 'groupOwner' | 'groupAdmin' | 'chatAdmin'

/**
 * Where a check looks. `bot`: the bot's masters and admins (and group roles). `chat`: only the
 * chat's members and rules (blocked users, features turned off or kept for tags). `both`: the
 * chat first, then the bot's lists.
 */
export type CheckSource = 'bot' | 'chat' | 'both'

export interface CheckTarget {
  botId: string
  user: UserInfo
  channel: ChannelInfo
  /** Already known, e.g. from a test; asked from the bot's adapter otherwise. */
  groupRole?: GroupRole
  /** Already known, e.g. a role a test pretends; read from the bot's lists otherwise. */
  role?: BotRole
}

export interface CheckOptions {
  source?: CheckSource
  /** The feature chat rules are matched against, such as a command name. */
  feature?: string
}

export interface CheckResult {
  ok: boolean
  role: BotRole
  groupRole?: GroupRole
  /** Why the check failed, in words a chat user can read; empty when it passed. */
  reason: string
  /** The sender's entry in the chat's members, when the check read it. */
  member?: ChatMember
}

/**
 * Another place a check can read roles from, such as per-chat rules kept in a database. Sources
 * run after the bot's lists; the first that returns a verdict decides.
 */
export interface PermissionSource {
  id: string
  check(target: CheckTarget, allowed: Allowed[]): Promise<CheckResult | undefined> | CheckResult | undefined
}

const STORAGE_KEY = 'permissions'

const ROLE_NAMES: Record<BotRole, string> = { master: '主人', admin: '管理员', user: '普通用户' }
const GROUP_NAMES: Record<GroupRole, string> = { owner: '群主', admin: '群管理员', member: '群成员' }
const ALLOWED_NAMES: Record<Allowed, string> = { master: '主人', admin: '管理员', user: '所有人', groupOwner: '群主', groupAdmin: '群管理员', chatAdmin: '本群管理' }

/** "至少 admin"-style summary of a choice of roles, for node cards and reasons. */
export function describeAllowed(allowed: Allowed[]) {
  const bot = (['user', 'admin', 'master'] as const).find((role) => allowed.includes(role))
  const parts = [
    ...(bot === 'user' ? ['所有人'] : bot === 'admin' ? ['管理员及以上'] : bot === 'master' ? ['主人'] : []),
    ...(allowed.includes('groupOwner') && !allowed.includes('groupAdmin') ? [ALLOWED_NAMES.groupOwner] : []),
    ...(allowed.includes('groupAdmin') ? ['群管理员（含群主）'] : []),
    ...(allowed.includes('chatAdmin') ? [ALLOWED_NAMES.chatAdmin] : []),
  ]
  return parts.join('或') || '无人'
}

/**
 * Whether a sender with these roles passes. Bot roles include lower ones; a group owner counts as
 * a group admin; `chatAdmin` is an admin in the chat's members.
 */
export function allows(allowed: Allowed[], role: BotRole, groupRole: GroupRole | undefined, chatRole?: ChatMember['role']) {
  if (allowed.includes('chatAdmin') && chatRole === 'admin') return true
  if (allowed.some((item) => (item === 'master' || item === 'admin' || item === 'user') && roleAtLeast(role, item))) return true
  if (allowed.includes('groupOwner') && groupRole === 'owner') return true
  if (allowed.includes('groupAdmin') && (groupRole === 'owner' || groupRole === 'admin')) return true
  return false
}

function reasonFor(allowed: Allowed[], role: BotRole, groupRole: GroupRole | undefined, channel: ChannelInfo) {
  const who = groupRole ? `${ROLE_NAMES[role]}（${GROUP_NAMES[groupRole]}）` : ROLE_NAMES[role]
  const groupOnly = allowed.every((item) => item === 'groupOwner' || item === 'groupAdmin')
  if (groupOnly && channel.type !== 'group') return `需要${describeAllowed(allowed)}，私聊中没有群身份`
  return `需要${describeAllowed(allowed)}，你是${who}`
}

const allowedEnum = z.enum(['master', 'admin', 'user', 'groupOwner', 'groupAdmin', 'chatAdmin'])
const sourceEnum = z.enum(['bot', 'chat', 'both'])
const listInput = z.array(z.string().regex(/^\S+$/, 'one user id per entry, without spaces'))

/**
 * Who is master, admin or user on each bot. Commands, flows and bot plugins ask through
 * `ctx.bots` (`session.role()`), and the permission check node branches on it. Stored with the
 * plugin's own storage, so it works without a database.
 */
export class Permissions extends Service {
  static inject = ['bots', 'storage', 'actions']

  private home: Context
  private data: StoredPermissions = { bots: {} }
  private sources = new Set<PermissionSource>()
  /** Chat members and rules, while the database plugin runs. */
  readonly chats = new ChatStore(() => this.home.get('flows')?.recompile())

  constructor(ctx: Context) {
    super(ctx, 'permissions')
    this.home = ctx
  }

  async *[Service.init]() {
    this.data = { bots: {}, ...(await this.home.storage.get<StoredPermissions>(STORAGE_KEY)) }
    await this.migrate()
    yield this.home.bots.usePermissions({ roleOf: (botId, userId) => this.roleOf(botId, userId) })
    yield* this.defineActions()
    yield this.home.on('bots/changed', () => {
      this.migrate().catch((error) => this.home.logger('permissions').warn('moving command admins failed: %s', error))
    })
    this.home.inject(['model', 'database'], (ctx) => {
      ctx.effect(() => this.chats.attach(ctx), 'permissions chats')
    })
    yield* this.defineChatCommands()
    // The permission check node and the member nodes, while the flows plugin runs.
    this.home.inject(['flows'], (ctx) => {
      ctx.flows.defineNode(permissionNode(this))
      for (const node of memberNodes(this.chats)) ctx.flows.defineNode(node)
    })
  }

  private migrating = Promise.resolve()

  /** Moves admins kept in each bot's command settings (before this plugin existed) to its admin list, once per bot. */
  private migrate() {
    this.migrating = this.migrating.then(async () => {
      const migrated = new Set(this.data.migrated ?? [])
      const fresh = this.home.bots.list().filter((bot) => !migrated.has(bot.id))
      if (!fresh.length) return
      this.data.migrated = [...migrated, ...fresh.map((bot) => bot.id)]
      const moved = fresh.filter((bot) => bot.commands?.admins?.some(Boolean))
      for (const bot of moved) {
        const entry = this.entry(bot.id)
        entry.admins = [...new Set([...entry.admins, ...bot.commands!.admins!.filter(Boolean)])]
      }
      await this.save()
      for (const bot of moved) {
        await this.home.bots.update(bot.id, { commands: { admins: undefined } })
        this.home.logger('permissions').info('moved the command admins of bot %s to its admin list', bot.id)
      }
    })
    return this.migrating
  }

  private entry(botId: string) {
    return this.data.bots[botId] ??= { masters: [], admins: [] }
  }

  private async save() {
    await this.home.storage.set(STORAGE_KEY, this.data)
  }

  /** The masters and admins of a bot. */
  get(botId: string): BotPermissions {
    const entry = this.data.bots[botId]
    return { masters: [...entry?.masters ?? []], admins: [...entry?.admins ?? []], chatCommands: !!entry?.chatCommands }
  }

  async update(botId: string, patch: Partial<BotPermissions>) {
    this.home.bots.get(botId)
    const entry = this.entry(botId)
    if (patch.masters) entry.masters = [...new Set(patch.masters.map((id) => id.trim()).filter(Boolean))]
    if (patch.admins) entry.admins = [...new Set(patch.admins.map((id) => id.trim()).filter(Boolean))]
    if (patch.chatCommands !== undefined) entry.chatCommands = patch.chatCommands
    await this.save()
    this.home.logger('permissions').info('updated permissions of bot %s: %d master(s), %d admin(s)', botId, entry.masters.length, entry.admins.length)
    this.home.emit('permissions/changed', botId)
    return this.get(botId)
  }

  /** A user's role on a bot: master, admin, or user for everyone else. */
  roleOf(botId: string, userId: string): BotRole {
    const entry = this.data.bots[botId]
    if (entry?.masters.includes(userId)) return 'master'
    if (entry?.admins.includes(userId)) return 'admin'
    return 'user'
  }

  /** The group role the bot's adapter reports for a sender; nothing in private chats or when the adapter cannot tell. */
  groupRoleOf(botId: string, target: { channel: ChannelInfo; user: UserInfo }) {
    const bot = this.home.bots.bot(botId)
    if (!bot) return Promise.resolve(target.channel.type === 'group' ? target.user.role : undefined)
    return bot.groupRoleOf(target)
  }

  /**
   * Checks a sender against allowed roles. With the chat as a source, a blocked member or a chat
   * rule for the feature can refuse first (masters pass them); with only the chat, nothing else is
   * asked. Then the bot's lists, then any added source.
   */
  async check(allowed: Allowed[], target: CheckTarget, options: CheckOptions = {}): Promise<CheckResult> {
    const source = options.source ?? 'bot'
    const role = target.role ?? this.roleOf(target.botId, target.user.id)
    const needsGroup = allowed.includes('groupOwner') || allowed.includes('groupAdmin')
    const groupRole = target.groupRole ?? (needsGroup && source !== 'chat' ? await this.groupRoleOf(target.botId, target) : undefined)
    const known = { role, ...(groupRole ? { groupRole } : {}) }
    let member: ChatMember | undefined
    if (source !== 'bot') {
      if (!this.chats.available) return { ok: false, ...known, reason: '会话规则需要数据库插件' }
      const verdict = await this.chats.verdict(target.botId, target.channel, target.user.id, role, options.feature ?? '')
      member = verdict.member
      if (!verdict.ok) return { ok: false, ...known, reason: verdict.reason, ...(member ? { member } : {}) }
      if (source === 'chat') return { ok: true, ...known, reason: '', ...(member ? { member } : {}) }
    } else if (allowed.includes('chatAdmin') && this.chats.available) {
      member = await this.chats.member(target.botId, channelKey(target.channel), target.user.id)
    }
    const withMember = member ? { member } : {}
    if (allows(allowed, role, groupRole, member?.role)) return { ok: true, ...known, reason: '', ...withMember }
    for (const source of this.sources) {
      const verdict = await source.check(target, allowed)
      if (verdict) return verdict
    }
    return { ok: false, ...known, reason: reasonFor(allowed, role, groupRole, target.channel), ...withMember }
  }

  /** Adds a place roles come from, such as a database of per-chat rules. Removed when the caller unloads. */
  defineSource(source: PermissionSource) {
    return this.ctx.effect(() => {
      this.sources.add(source)
      return () => this.sources.delete(source)
    }, `permissions.defineSource(${source.id})`)
  }

  private *defineActions() {
    const actions = this.home.actions
    const botInput = z.object({ bot: z.string().describe('Bot id from bots.list') })

    yield actions.define({
      name: 'permissions.get',
      description: 'The masters and admins of a bot (user ids), and whether its adapter can tell group roles (group owner, group admin) for the permission check node. Everyone not listed is a user.',
      risk: 'read',
      input: botInput,
      handler: ({ bot }) => {
        const record = this.home.bots.get(bot)
        const adapter = this.home.bots.adapters().find((item) => item.id === record.adapter.type)
        return { ...this.get(bot), groupRoles: !!adapter?.groupRoles, chats: this.chats.available }
      },
    })

    yield actions.define({
      name: 'permissions.update',
      description: 'Set the masters and/or admins of a bot (user ids, e.g. QQ numbers). Each list replaces the old one, so send everyone who should stay. Masters own the bot; admins help manage it; masters pass every admin check.',
      risk: 'write',
      input: botInput.extend({
        masters: listInput.optional(),
        admins: listInput.optional(),
        chatCommands: z.boolean().optional().describe('Turn on the chat commands /拉黑, /解除拉黑, /设为管理, /取消管理, /加标签, /去标签 for this bot (needs the database)'),
      }),
      handler: ({ bot, ...patch }) => this.update(bot, patch),
    })

    yield actions.define({
      name: 'permissions.check',
      description: 'Check a user against allowed roles on a bot, like the permission check node: bot roles master, admin, user (higher roles pass too) and group roles groupOwner, groupAdmin (needs a group and an adapter that can tell). Returns ok, the role, the group role and the reason it failed.',
      risk: 'read',
      input: botInput.extend({
        user: z.string().describe('User id'),
        allow: z.array(allowedEnum).min(1).default(['admin']),
        group: z.string().optional().describe('Group id, for group roles and chat rules'),
        source: sourceEnum.default('bot').describe('bot: the bot\'s lists; chat: only the chat\'s members and rules; both: chat first, then the lists'),
        feature: z.string().optional().describe('For chat rules: the command name or feature'),
      }),
      handler: ({ bot, user, allow, group, source, feature }) => {
        this.home.bots.get(bot)
        const channel: ChannelInfo = group ? { type: 'group', id: group } : { type: 'private', id: user }
        return this.check(allow, { botId: bot, user: { id: user }, channel }, { source, ...(feature ? { feature } : {}) })
      },
    })

    const chatInput = botInput.extend({ channel: z.string().regex(/^(group|private):\S+$/).describe('The chat, as group:<id> or private:<user id>') })
    const memberAction = z.enum(['block', 'unblock', 'setAdmin', 'unsetAdmin', 'addTag', 'removeTag', 'setNote', 'remove'])

    yield actions.define({
      name: 'permissions.chats',
      description: 'Chats of a bot with chat members or rules (needs the database), with how many members, blocked members and rules each has.',
      risk: 'read',
      input: botInput,
      handler: ({ bot }) => {
        this.home.bots.get(bot)
        return this.chats.chats(bot)
      },
    })

    yield actions.define({
      name: 'permissions.members.list',
      description: 'The members a chat keeps for its own user management: chat role (admin / member), tags, blocked, note, when they were added. Chat admins pass checks that allow chatAdmin.',
      risk: 'read',
      input: chatInput,
      handler: ({ bot, channel }) => this.chats.members(bot, channel),
    })

    yield actions.define({
      name: 'permissions.members.set',
      description: 'Add or change a chat member: chat role, tags (replaces them), blocked, note. Fields left out keep their value.',
      risk: 'write',
      input: chatInput.extend({
        user: z.string().regex(/^\S+$/),
        role: z.enum(['admin', 'member']).optional(),
        tags: z.array(z.string()).optional(),
        blocked: z.boolean().optional(),
        note: z.string().optional(),
      }),
      handler: ({ bot, channel, user, ...patch }) => this.chats.setMember(bot, channel, user, patch as ChatMemberPatch),
    })

    yield actions.define({
      name: 'permissions.members.act',
      description: 'One change to a chat member, like the member node: block, unblock, setAdmin, unsetAdmin, addTag, removeTag (value is the tag), setNote (value is the note) or remove.',
      risk: 'write',
      input: chatInput.extend({ user: z.string().regex(/^\S+$/), action: memberAction, value: z.string().default('') }),
      handler: async ({ bot, channel, user, action, value }) => (await applyMemberAction(this.chats, bot, channel, user, action, value)) ?? { removed: user },
    })

    yield actions.define({
      name: 'permissions.rules.list',
      description: 'Chat rules of a bot (all chats, or one): feature (command name or *), effect off (turned off here) or tags (only members with one of the tags), tags, note.',
      risk: 'read',
      input: botInput.extend({ channel: z.string().optional() }),
      handler: ({ bot, channel }) => this.chats.rules(bot, channel),
    })

    yield actions.define({
      name: 'permissions.rules.create',
      description: 'Add a chat rule, e.g. only members tagged VIP may use 抽奖 in a group, or turn ai off there. Rules apply to permission checks whose source includes the chat, and to commands. Masters always pass.',
      risk: 'write',
      input: chatInput.extend({ rule: RuleInput }),
      handler: ({ bot, channel, rule }) => this.chats.addRule(bot, channel, rule),
    })

    yield actions.define({
      name: 'permissions.rules.update',
      description: 'Change a chat rule.',
      risk: 'write',
      input: botInput.extend({ id: z.number().int(), rule: RuleInput.partial() }),
      handler: ({ bot, id, rule }) => this.chats.updateRule(bot, id, rule),
    })

    yield actions.define({
      name: 'permissions.rules.delete',
      description: 'Delete a chat rule.',
      risk: 'write',
      input: botInput.extend({ id: z.number().int() }),
      handler: ({ bot, id }) => this.chats.removeRule(bot, id),
    })
  }

  // ---- chat commands ----

  private *defineChatCommands() {
    const commands: { name: string; description: string; usage: string; action: MemberAction; needsBotAdmin?: boolean; done: string }[] = [
      { name: '拉黑', description: '在本群拉黑某人（管理员）', usage: '<@某人>', action: 'block', done: '已在本群拉黑 {user}' },
      { name: '解除拉黑', description: '在本群解除拉黑（管理员）', usage: '<@某人>', action: 'unblock', done: '已解除 {user} 的拉黑' },
      { name: '设为管理', description: '设为本群管理（机器人管理员）', usage: '<@某人>', action: 'setAdmin', needsBotAdmin: true, done: '已把 {user} 设为本群管理' },
      { name: '取消管理', description: '取消本群管理（机器人管理员）', usage: '<@某人>', action: 'unsetAdmin', needsBotAdmin: true, done: '已取消 {user} 的本群管理' },
      { name: '加标签', description: '给本群成员加标签（管理员）', usage: '<@某人> <标签>', action: 'addTag', done: '已给 {user} 加上标签“{tag}”' },
      { name: '去标签', description: '移除本群成员的标签（管理员）', usage: '<@某人> <标签>', action: 'removeTag', done: '已移除 {user} 的标签“{tag}”' },
    ]
    for (const command of commands) {
      yield this.home.bots.defineCommand(
        { name: command.name, description: command.description, usage: command.usage },
        (session) => this.runChatCommand(session, command),
        { bots: (botId) => !!this.data.bots[botId]?.chatCommands && this.chats.available },
      )
    }
  }

  /** Runs `/拉黑 @someone` and the like: bot admins, or the chat's own admins, manage members; only bot admins name chat admins. */
  private async runChatCommand(session: Session, command: { action: MemberAction; needsBotAdmin?: boolean; done: string }) {
    if (session.channel.type !== 'group') {
      await session.send('这个指令只能在群里使用')
      return
    }
    const botId = session.bot.id
    const channel = channelKey(session.channel)
    const role = session.role() ?? 'user'
    const self = await this.chats.member(botId, channel, session.user.id)
    const allowed = roleAtLeast(role, 'admin') || (!command.needsBotAdmin && self?.role === 'admin' && !self.blocked)
    if (!allowed) {
      await session.send(command.needsBotAdmin ? '只有机器人的管理员可以设置本群管理' : '只有管理员可以管理本群成员')
      return
    }
    const mentioned = session.segments.find((s) => s.type === 'at' && String(s.data.qq) !== session.bot.selfId && s.data.qq !== 'all')
    const words = (session.command?.rest ?? '').trim().split(/\s+/).filter(Boolean)
    const user = mentioned ? String(mentioned.data.qq) : words.shift()
    if (mentioned && words[0] === `@${mentioned.data.name ?? mentioned.data.qq}`) words.shift()
    if (!user || !/^\S+$/.test(user)) {
      await session.send('请 @ 要管理的成员，或写上对方的 QQ 号')
      return
    }
    const tag = words.join(' ').trim()
    if ((command.action === 'addTag' || command.action === 'removeTag') && !tag) {
      await session.send('请写上标签，例如 /加标签 @某人 VIP')
      return
    }
    if (command.action === 'block' && this.roleOf(botId, user) === 'master') {
      await session.send('不能拉黑机器人的主人')
      return
    }
    await applyMemberAction(this.chats, botId, channel, user, command.action, tag)
    await session.send(command.done.replace('{user}', user).replace('{tag}', tag))
  }
}

const allowField = z.array(allowedEnum).min(1).default(['master', 'admin']).meta(field(
  'Allowed',
  'Passes when the sender has any of these. Bot roles include lower ones (an admin check lets masters through); group roles need an adapter that reports them, and a group owner counts as a group admin.',
  {
    'zh-CN': {
      title: '允许',
      description: '满足任一项即通过。机器人角色向下包含（允许管理员时主人也能通过）；群身份需要适配器支持，群主也算群管理员。',
      options: { master: '主人', admin: '管理员', user: '所有人', groupOwner: '群主', groupAdmin: '群管理员', chatAdmin: '本群管理（成员表）' },
    },
  },
  { options: { master: 'Master', admin: 'Admin', user: 'Everyone', groupOwner: 'Group owner', groupAdmin: 'Group admin', chatAdmin: 'Chat admin (members)' } },
))

const sourceField = sourceEnum.default('bot').meta(field(
  'Check',
  'Bot lists: the bot\'s masters and admins (and group roles). Chat rules: only the chat\'s members and rules, ignoring Allowed. Both: the chat first (blocked users, features turned off or kept for tags), then Allowed. Chat rules need the Database plugin.',
  {
    'zh-CN': {
      title: '依据',
      description: '机器人名单：按机器人的主人、管理员（和群身份）判断。会话规则：只看本会话的成员表和规则，不看“允许”。两者：先看本会话（拉黑、关闭的功能、需要的标签），再按“允许”判断。会话规则需要数据库插件。',
      options: { bot: '机器人名单', chat: '会话规则', both: '两者' },
    },
  },
  { options: { bot: 'Bot lists', chat: 'Chat rules', both: 'Both' } },
))

const featureField = z.string().default('').meta(field(
  'Feature',
  'The name chat rules use for what this check guards, e.g. 抽奖. Empty: the command that started the run.',
  { 'zh-CN': { title: '功能名', description: '会话规则里用来指代这里所保护功能的名字，例如“抽奖”。留空时用触发这次运行的指令名。' } },
))

/** The permission check node: branches on `allow` or `deny`, and stays silent itself. */
export function permissionNode(permissions: Permissions): NodeType {
  return {
    kind: 'action',
    type: 'logic.permission',
    category: 'logic',
    title: { en: 'Permission check', 'zh-CN': '权限检测' },
    description: {
      en: 'Continues on "allow" when the sender has one of the allowed roles, otherwise on "deny". It sends nothing itself; put a reply after "deny" if you want one, e.g. with {{<this node>.reason}}.',
      'zh-CN': '发送者满足允许的角色时走 allow，否则走 deny。节点本身不回复；需要提示时在 deny 后接回复节点，例如用 {{<本节点>.reason}}。',
    },
    config: z.object({ allow: allowField, source: sourceField, feature: featureField }),
    outputs: [
      { name: 'role', type: 'text', title: { en: 'Bot role (master / admin / user)', 'zh-CN': '机器人角色（master / admin / user）' } },
      { name: 'groupRole', type: 'text', title: { en: 'Group role (owner / admin / member)', 'zh-CN': '群身份（owner / admin / member）' } },
      { name: 'reason', type: 'text', title: { en: 'Why it was denied', 'zh-CN': '未通过原因' } },
      { name: 'tags', type: 'any', title: { en: 'Tags in this chat', 'zh-CN': '本会话中的标签' } },
    ],
    execOut: ['allow', 'deny'],
    async run({ config, session, bot }) {
      const allowed = config.allow as Allowed[]
      const source = (config.source ?? 'bot') as CheckSource
      const role = sessionRole(session, bot?.id, permissions)
      const needsGroup = allowed.includes('groupOwner') || allowed.includes('groupAdmin')
      const groupRole = needsGroup || session.groupRole ? await session.groupRole?.() : undefined
      const feature = String(config.feature ?? '').trim() || session.command?.entry?.name || session.command?.name || ''
      const verdict = await permissions.check(allowed, { botId: bot?.id ?? 'test', user: session.user, channel: session.channel, role, ...(groupRole ? { groupRole } : {}) }, { source, feature })
      return {
        exec: verdict.ok ? 'allow' : 'deny',
        outputs: { role: verdict.role, groupRole: verdict.groupRole ?? '', reason: verdict.reason, tags: verdict.member?.tags ?? [] },
      }
    },
  }
}

/** The sender's role: from the session (real messages and tests), else from the bot's lists. */
function sessionRole(session: FlowSession, botId: string | undefined, permissions: Permissions): BotRole {
  const role = session.role?.()
  if (role) return role
  if (botId && botId !== 'test') return permissions.roleOf(botId, session.user.id)
  return session.isAdmin ? 'admin' : 'user'
}

export default Permissions
