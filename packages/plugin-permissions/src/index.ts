import { type ChannelInfo, Context, field, MushinError, Service, type UserInfo, z } from '@mushin/core'
import { type BotRole, type GroupRole, roleAtLeast } from '@mushin/plugin-bots'
import type { FlowSession, NodeType } from '@mushin/plugin-flows'
import type {} from '@mushin/plugin-storage'

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
}

interface StoredPermissions {
  bots: Record<string, BotPermissions>
  /** Bots whose old command admins (`commands.admins`) were moved here. */
  migrated?: string[]
}

/** What a permission check allows: bot roles (higher roles pass too) and group roles. */
export type Allowed = 'master' | 'admin' | 'user' | 'groupOwner' | 'groupAdmin'

export interface CheckTarget {
  botId: string
  user: UserInfo
  channel: ChannelInfo
  /** Already known, e.g. from a test; asked from the bot's adapter otherwise. */
  groupRole?: GroupRole
}

export interface CheckResult {
  ok: boolean
  role: BotRole
  groupRole?: GroupRole
  /** Why the check failed, in words a chat user can read; empty when it passed. */
  reason: string
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
const ALLOWED_NAMES: Record<Allowed, string> = { master: '主人', admin: '管理员', user: '所有人', groupOwner: '群主', groupAdmin: '群管理员' }

/** "至少 admin"-style summary of a choice of roles, for node cards and reasons. */
export function describeAllowed(allowed: Allowed[]) {
  const bot = (['user', 'admin', 'master'] as const).find((role) => allowed.includes(role))
  const parts = [
    ...(bot === 'user' ? ['所有人'] : bot === 'admin' ? ['管理员及以上'] : bot === 'master' ? ['主人'] : []),
    ...(allowed.includes('groupOwner') && !allowed.includes('groupAdmin') ? [ALLOWED_NAMES.groupOwner] : []),
    ...(allowed.includes('groupAdmin') ? ['群管理员（含群主）'] : []),
  ]
  return parts.join('或') || '无人'
}

/** Whether a sender with these roles passes. Bot roles include lower ones; a group owner counts as a group admin. */
export function allows(allowed: Allowed[], role: BotRole, groupRole: GroupRole | undefined) {
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

const allowedEnum = z.enum(['master', 'admin', 'user', 'groupOwner', 'groupAdmin'])
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
    // The permission check node, while the flows plugin runs.
    this.home.inject(['flows'], (ctx) => {
      ctx.flows.defineNode(permissionNode(this))
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
    return { masters: [...entry?.masters ?? []], admins: [...entry?.admins ?? []] }
  }

  async update(botId: string, patch: Partial<BotPermissions>) {
    this.home.bots.get(botId)
    const entry = this.entry(botId)
    if (patch.masters) entry.masters = [...new Set(patch.masters.map((id) => id.trim()).filter(Boolean))]
    if (patch.admins) entry.admins = [...new Set(patch.admins.map((id) => id.trim()).filter(Boolean))]
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

  /** Checks a sender against allowed roles: the bot's lists first, then any added source. */
  async check(allowed: Allowed[], target: CheckTarget): Promise<CheckResult> {
    const role = this.roleOf(target.botId, target.user.id)
    const needsGroup = allowed.includes('groupOwner') || allowed.includes('groupAdmin')
    const groupRole = target.groupRole ?? (needsGroup ? await this.groupRoleOf(target.botId, target) : undefined)
    if (allows(allowed, role, groupRole)) return { ok: true, role, ...(groupRole ? { groupRole } : {}), reason: '' }
    for (const source of this.sources) {
      const verdict = await source.check(target, allowed)
      if (verdict) return verdict
    }
    return { ok: false, role, ...(groupRole ? { groupRole } : {}), reason: reasonFor(allowed, role, groupRole, target.channel) }
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
        return { ...this.get(bot), groupRoles: !!adapter?.groupRoles }
      },
    })

    yield actions.define({
      name: 'permissions.update',
      description: 'Set the masters and/or admins of a bot (user ids, e.g. QQ numbers). Each list replaces the old one, so send everyone who should stay. Masters own the bot; admins help manage it; masters pass every admin check.',
      risk: 'write',
      input: botInput.extend({ masters: listInput.optional(), admins: listInput.optional() }),
      handler: ({ bot, ...patch }) => this.update(bot, patch),
    })

    yield actions.define({
      name: 'permissions.check',
      description: 'Check a user against allowed roles on a bot, like the permission check node: bot roles master, admin, user (higher roles pass too) and group roles groupOwner, groupAdmin (needs a group and an adapter that can tell). Returns ok, the role, the group role and the reason it failed.',
      risk: 'read',
      input: botInput.extend({
        user: z.string().describe('User id'),
        allow: z.array(allowedEnum).min(1).default(['admin']),
        group: z.string().optional().describe('Group id, for group roles'),
      }),
      handler: ({ bot, user, allow, group }) => {
        this.home.bots.get(bot)
        const channel: ChannelInfo = group ? { type: 'group', id: group } : { type: 'private', id: user }
        return this.check(allow, { botId: bot, user: { id: user }, channel })
      },
    })
  }
}

const allowField = z.array(allowedEnum).min(1).default(['master', 'admin']).meta(field(
  'Allowed',
  'Passes when the sender has any of these. Bot roles include lower ones (an admin check lets masters through); group roles need an adapter that reports them, and a group owner counts as a group admin.',
  {
    'zh-CN': {
      title: '允许',
      description: '满足任一项即通过。机器人角色向下包含（允许管理员时主人也能通过）；群身份需要适配器支持，群主也算群管理员。',
      options: { master: '主人', admin: '管理员', user: '所有人', groupOwner: '群主', groupAdmin: '群管理员' },
    },
  },
  { options: { master: 'Master', admin: 'Admin', user: 'Everyone', groupOwner: 'Group owner', groupAdmin: 'Group admin' } },
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
    config: z.object({ allow: allowField }),
    outputs: [
      { name: 'role', type: 'text', title: { en: 'Bot role (master / admin / user)', 'zh-CN': '机器人角色（master / admin / user）' } },
      { name: 'groupRole', type: 'text', title: { en: 'Group role (owner / admin / member)', 'zh-CN': '群身份（owner / admin / member）' } },
      { name: 'reason', type: 'text', title: { en: 'Why it was denied', 'zh-CN': '未通过原因' } },
    ],
    execOut: ['allow', 'deny'],
    async run({ config, session, bot }) {
      const allowed = config.allow as Allowed[]
      const role = sessionRole(session, bot?.id, permissions)
      const needsGroup = allowed.includes('groupOwner') || allowed.includes('groupAdmin')
      const groupRole = needsGroup || session.groupRole ? await session.groupRole?.() : undefined
      const ok = allows(allowed, role, groupRole)
      const verdict = ok || !bot?.id || bot.id === 'test'
        ? { ok, role, groupRole, reason: ok ? '' : reasonFor(allowed, role, groupRole, session.channel) }
        : await permissions.check(allowed, { botId: bot.id, user: session.user, channel: session.channel, groupRole })
      return {
        exec: verdict.ok ? 'allow' : 'deny',
        outputs: { role: verdict.role, groupRole: verdict.groupRole ?? '', reason: verdict.reason },
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
