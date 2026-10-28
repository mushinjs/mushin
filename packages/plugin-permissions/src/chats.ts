import { type ChannelInfo, type Context, field, MushinError, z } from '@mushin/core'
import type { BotRole } from '@mushin/plugin-bots'
import type {} from '@mushin/plugin-database'
import type { FlowSession, NodeContext, NodeType } from '@mushin/plugin-flows'

declare module 'minato' {
  interface Tables {
    permissions_member: ChatMember
    permissions_rule: ChatRule
  }
}

/** A user in one chat of a bot, as the chat's own user management sees them. */
export interface ChatMember {
  bot: string
  /** `group:<id>` or `private:<id>`. */
  channel: string
  user: string
  /** `admin` manages the chat's members; everyone else is `member`. */
  role: 'admin' | 'member'
  tags: string[]
  blocked: boolean
  note: string
  joinedAt: number
  updatedAt: number
}

/**
 * A rule for one feature in one chat: `off` turns it off, `tags` lets only members with one of the
 * tags use it. The feature is a command name (without prefix) or any name a permission check node
 * gives; `*` means every feature.
 */
export interface ChatRule {
  id: number
  bot: string
  channel: string
  feature: string
  effect: 'off' | 'tags'
  tags: string[]
  note: string
  createdAt: number
}

export type ChatMemberPatch = Partial<Pick<ChatMember, 'role' | 'tags' | 'blocked' | 'note'>>
export const RuleInput = z.object({
  feature: z.string().trim().min(1).max(60).describe('Command name without prefix, a name a permission check node uses, or * for everything'),
  effect: z.enum(['off', 'tags']).describe('off: nobody but masters may use it here; tags: only members with one of the tags'),
  tags: z.array(z.string().trim().min(1)).default([]),
  note: z.string().default(''),
})
export type RuleInput = z.infer<typeof RuleInput>

export const channelKey = (channel: Pick<ChannelInfo, 'type' | 'id'>) => `${channel.type}:${channel.id}`

/** Why a chat refuses a sender, or nothing when it does not. */
export interface ChatVerdict {
  ok: boolean
  reason: string
  member?: ChatMember
}

/** Chat members and rules, kept in the database. */
export class ChatStore {
  private ctx?: Context

  constructor(private onChange: () => void) {}

  attach(ctx: Context) {
    ctx.model.extend('permissions_member', {
      bot: 'string',
      channel: 'string',
      user: 'string',
      role: 'string',
      tags: 'json',
      blocked: 'boolean',
      note: 'string',
      joinedAt: 'double',
      updatedAt: 'double',
    }, { primary: ['bot', 'channel', 'user'] })
    ctx.model.extend('permissions_rule', {
      id: 'unsigned',
      bot: 'string',
      channel: 'string',
      feature: 'string',
      effect: 'string',
      tags: 'json',
      note: 'string',
      createdAt: 'double',
    }, { autoInc: true, indexes: [['bot', 'channel']] })
    this.ctx = ctx
    this.onChange()
    return () => {
      if (this.ctx === ctx) this.ctx = undefined
      this.onChange()
    }
  }

  get available() {
    return !!this.ctx
  }

  private get database() {
    if (!this.ctx) throw new MushinError('unavailable', 'Chat members and rules need the Database plugin; enable it on the plugins page')
    return this.ctx.database
  }

  async members(bot: string, channel: string) {
    return (await this.database.get('permissions_member', { bot, channel }, { sort: { updatedAt: 'desc' } })).map(normalizeMember)
  }

  async member(bot: string, channel: string, user: string): Promise<ChatMember | undefined> {
    const [row] = await this.database.get('permissions_member', { bot, channel, user })
    return row && normalizeMember(row)
  }

  async setMember(bot: string, channel: string, user: string, patch: ChatMemberPatch) {
    const current = await this.member(bot, channel, user)
    const now = Date.now()
    const next: ChatMember = {
      bot,
      channel,
      user,
      role: patch.role ?? current?.role ?? 'member',
      tags: [...new Set((patch.tags ?? current?.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
      blocked: patch.blocked ?? current?.blocked ?? false,
      note: patch.note ?? current?.note ?? '',
      joinedAt: current?.joinedAt ?? now,
      updatedAt: now,
    }
    await this.database.upsert('permissions_member', [next])
    return next
  }

  async removeMember(bot: string, channel: string, user: string) {
    await this.database.remove('permissions_member', { bot, channel, user })
    return { removed: user }
  }

  async rules(bot: string, channel?: string) {
    return (await this.database.get('permissions_rule', channel ? { bot, channel } : { bot }, { sort: { createdAt: 'asc' } })).map(normalizeRule)
  }

  async addRule(bot: string, channel: string, input: RuleInput) {
    const rule = RuleInput.parse(input)
    if (rule.effect === 'tags' && !rule.tags.length) throw new MushinError('invalid_input', 'A tags rule needs at least one tag')
    return normalizeRule(await this.database.create('permissions_rule', { bot, channel, ...rule, createdAt: Date.now() }))
  }

  async updateRule(bot: string, id: number, input: Partial<RuleInput>) {
    const [current] = await this.database.get('permissions_rule', { bot, id })
    if (!current) throw new MushinError('not_found', `No rule ${id} on this bot`)
    const rule = RuleInput.parse({ ...normalizeRule(current), ...input })
    if (rule.effect === 'tags' && !rule.tags.length) throw new MushinError('invalid_input', 'A tags rule needs at least one tag')
    await this.database.set('permissions_rule', { bot, id }, rule)
    return { ...normalizeRule(current), ...rule }
  }

  async removeRule(bot: string, id: number) {
    const [current] = await this.database.get('permissions_rule', { bot, id })
    if (!current) throw new MushinError('not_found', `No rule ${id} on this bot`)
    await this.database.remove('permissions_rule', { bot, id })
    return { removed: id }
  }

  /** Chats of a bot that have members or rules, with how many of each. */
  async chats(bot: string) {
    const seen = new Map<string, { channel: string; members: number; blocked: number; rules: number }>()
    const entry = (channel: string) => {
      let item = seen.get(channel)
      if (!item) seen.set(channel, item = { channel, members: 0, blocked: 0, rules: 0 })
      return item
    }
    for (const row of await this.database.get('permissions_member', { bot }, ['channel', 'blocked'])) {
      const item = entry(row.channel)
      item.members++
      if (row.blocked) item.blocked++
    }
    for (const row of await this.database.get('permissions_rule', { bot }, ['channel'])) entry(row.channel).rules++
    return [...seen.values()]
  }

  /**
   * Whether a chat lets a sender use a feature: masters always may; a blocked member never; then
   * the chat's rules for the feature (or `*`).
   */
  async verdict(bot: string, channel: ChannelInfo, user: string, role: BotRole, feature: string): Promise<ChatVerdict> {
    const key = channelKey(channel)
    const member = await this.member(bot, key, user)
    if (role === 'master') return { ok: true, reason: '', member }
    if (member?.blocked) return { ok: false, reason: channel.type === 'group' ? '你已被本群拉黑' : '你已被拉黑', member }
    const name = feature.trim().toLowerCase()
    const rules = (await this.rules(bot, key)).filter((rule) => rule.feature === '*' || (!!name && rule.feature.toLowerCase() === name))
    for (const rule of rules) {
      if (rule.effect === 'off') return { ok: false, reason: rule.feature === '*' ? '本群已关闭机器人的功能' : `本群已关闭“${rule.feature}”`, member }
      if (rule.effect === 'tags' && !rule.tags.some((tag) => member?.tags.includes(tag))) {
        return { ok: false, reason: `需要标签${rule.tags.map((tag) => `“${tag}”`).join('或')}才能使用${rule.feature === '*' ? '' : `“${rule.feature}”`}`, member }
      }
    }
    return { ok: true, reason: '', member }
  }
}

function normalizeMember(row: any): ChatMember {
  return { ...row, role: row.role === 'admin' ? 'admin' : 'member', tags: Array.isArray(row.tags) ? row.tags : [], blocked: !!row.blocked, note: row.note ?? '' }
}

function normalizeRule(row: any): ChatRule {
  return { ...row, effect: row.effect === 'off' ? 'off' : 'tags', tags: Array.isArray(row.tags) ? row.tags : [], note: row.note ?? '' }
}

// ---- nodes ----

const UNAVAILABLE = {
  en: 'Needs the Database plugin; enable it on the plugins page',
  'zh-CN': '需要数据库插件，请先在插件页启用',
}

const userField = (fallback: string) => z.string().default(fallback).meta(field('User', 'User id, e.g. {{sys.userId}} or a command argument', {
  'zh-CN': { title: '用户', description: '用户 ID，例如 {{sys.userId}} 或指令参数' },
}))

export const MEMBER_ACTIONS = ['block', 'unblock', 'setAdmin', 'unsetAdmin', 'addTag', 'removeTag', 'setNote', 'remove'] as const
export type MemberAction = typeof MEMBER_ACTIONS[number]

/** Applies a member action; returns the member after it (nothing once removed). */
export async function applyMemberAction(store: ChatStore, bot: string, channel: string, user: string, action: MemberAction, value = '') {
  if (action === 'remove') {
    await store.removeMember(bot, channel, user)
    return undefined
  }
  const current = await store.member(bot, channel, user)
  const tags = current?.tags ?? []
  const patch: ChatMemberPatch = action === 'block' ? { blocked: true }
    : action === 'unblock' ? { blocked: false }
    : action === 'setAdmin' ? { role: 'admin' }
    : action === 'unsetAdmin' ? { role: 'member' }
    : action === 'addTag' ? { tags: [...tags, value] }
    : action === 'removeTag' ? { tags: tags.filter((tag) => tag !== value.trim()) }
    : { note: value }
  return store.setMember(bot, channel, user, patch)
}

const chatOf = (session: FlowSession) => channelKey(session.channel)

/** The member nodes: change a member of the current chat, and read one. */
export function memberNodes(store: ChatStore): NodeType[] {
  const unavailable = () => (store.available ? undefined : UNAVAILABLE)
  const botOf = (context: NodeContext<any>) => context.bot?.id ?? 'test'

  const change: NodeType = {
    kind: 'action',
    type: 'perm.member',
    category: 'data',
    title: { en: 'Manage chat member', 'zh-CN': '管理会话成员' },
    description: {
      en: 'Blocks or unblocks a user in this chat, makes them a chat admin, or adds and removes a tag. It checks nothing itself: put a permission check before it. Test runs list the change instead of making it.',
      'zh-CN': '在本会话里拉黑或解除拉黑、设为或取消本群管理、添加或移除标签。节点本身不检查权限，请在前面接权限检测。测试运行只列出要做的修改，不真正写入。',
    },
    unavailable,
    config: z.object({
      action: z.enum(MEMBER_ACTIONS).default('block').meta(field('Action', undefined, {
        'zh-CN': {
          title: '操作',
          options: { block: '拉黑', unblock: '解除拉黑', setAdmin: '设为本群管理', unsetAdmin: '取消本群管理', addTag: '添加标签', removeTag: '移除标签', setNote: '设置备注', remove: '移出成员表' },
        },
      }, { options: { block: 'Block', unblock: 'Unblock', setAdmin: 'Make chat admin', unsetAdmin: 'Remove chat admin', addTag: 'Add tag', removeTag: 'Remove tag', setNote: 'Set note', remove: 'Remove from members' } })),
      user: userField(''),
      value: z.string().default('').meta(field('Tag or note', 'For adding or removing a tag, or setting the note', {
        'zh-CN': { title: '标签或备注', description: '添加、移除标签或设置备注时使用' },
      })),
    }),
    outputs: [
      { name: 'tags', type: 'any', title: { en: 'Tags after the change', 'zh-CN': '修改后的标签' } },
      { name: 'blocked', type: 'boolean', title: { en: 'Blocked', 'zh-CN': '已拉黑' } },
    ],
    async run(context) {
      const { config, session } = context
      const user = String(config.user ?? '').trim()
      if (!user) throw new Error('Say which user: set "User", e.g. to {{sys.userId}} or a command argument')
      const action = config.action as MemberAction
      if ((action === 'addTag' || action === 'removeTag') && !String(config.value).trim()) throw new Error('Give the tag to add or remove')
      if (context.test) {
        await context.bot?.call('permissions.member', { channel: chatOf(session), user, action, ...(config.value ? { value: config.value } : {}) })
        const current = await store.member(botOf(context), chatOf(session), user).catch(() => undefined)
        return { outputs: { tags: current?.tags ?? [], blocked: action === 'block' ? true : action === 'unblock' ? false : !!current?.blocked } }
      }
      const member = await applyMemberAction(store, botOf(context), chatOf(session), user, action, String(config.value ?? ''))
      return { outputs: { tags: member?.tags ?? [], blocked: !!member?.blocked } }
    },
  }

  const read: NodeType = {
    kind: 'action',
    type: 'perm.memberInfo',
    category: 'data',
    title: { en: 'Chat member', 'zh-CN': '读取会话成员' },
    description: {
      en: 'Reads a user of this chat from the chat members: their chat role, tags, whether they are blocked, and whether they have a tag.',
      'zh-CN': '读取本会话成员表里的用户：本群角色、标签、是否被拉黑，以及是否有某个标签。',
    },
    unavailable,
    config: z.object({
      user: userField('{{sys.userId}}'),
      tag: z.string().default('').meta(field('Has tag', 'Outputs whether the user has this tag', {
        'zh-CN': { title: '是否有标签', description: '输出用户是否有这个标签' },
      })),
    }),
    outputs: [
      { name: 'known', type: 'boolean', title: { en: 'In the members list', 'zh-CN': '在成员表里' } },
      { name: 'role', type: 'text', title: { en: 'Chat role (admin / member)', 'zh-CN': '本群角色（admin / member）' } },
      { name: 'tags', type: 'any', title: { en: 'Tags', 'zh-CN': '标签' } },
      { name: 'hasTag', type: 'boolean', title: { en: 'Has the tag', 'zh-CN': '有该标签' } },
      { name: 'blocked', type: 'boolean', title: { en: 'Blocked', 'zh-CN': '已拉黑' } },
      { name: 'note', type: 'text', title: { en: 'Note', 'zh-CN': '备注' } },
    ],
    async run(context) {
      const { config, session } = context
      const member = await store.member(botOf(context), chatOf(session), String(config.user ?? '').trim())
      return {
        outputs: {
          known: !!member,
          role: member?.role ?? 'member',
          tags: member?.tags ?? [],
          hasTag: !!config.tag && !!member?.tags.includes(String(config.tag).trim()),
          blocked: !!member?.blocked,
          note: member?.note ?? '',
        },
      }
    },
  }

  return [change, read]
}
