import { field, type LocalizedText, type Segment, z } from '@mushin/core'
import { FlowError, type FlowEvent, type FlowSession, type NodeCategory, type NodeContext, type NodeResult, type NodeType, type PortDef, resolveTarget } from '@mushin/plugin-flows'
import { idOf } from './events'

/**
 * Flow nodes for OneBot v11, following the OneBot 11 spec and NapCat's extensions. Triggers match
 * the events the adapter names in `normalizeEvent`; action nodes call the API through `ctx.bot.call`.
 * Ids are passed as numbers when they are numeric, as the spec says; NapCat accepts both.
 */

// ---- shared pieces ----

const text = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })
const port = (name: string, type: PortDef['type'], en: string, zh: string): PortDef => ({ name, type, title: text(en, zh) })

const str = (value: unknown) => (value === undefined || value === null ? '' : String(value).trim())

function toId(value: string): number | string {
  const number = Number(value)
  return /^\d+$/.test(value) && Number.isSafeInteger(number) ? number : value
}

const groupIdField = z.string().default('').meta(field(
  'Group',
  'Group id; empty uses the group the run is about. Supports references such as {{n1.groupId}}.',
  { 'zh-CN': { title: '群号', description: '留空则使用本次运行所在的群；支持 {{n1.groupId}} 这样的变量引用' } },
))

const userIdField = z.string().default('').meta(field(
  'User',
  'QQ number; empty uses the sender (or the person the event is about). Supports references.',
  { 'zh-CN': { title: 'QQ 号', description: '留空则使用发送者（或事件涉及的人）；支持变量引用' } },
))

const messageIdField = z.string().default('').meta(field(
  'Message',
  'Message id; empty uses the message that started the run. Use {{n2.messageId}} for a message the bot sent.',
  { 'zh-CN': { title: '消息 ID', description: '留空则使用触发本次运行的消息；机器人发出的消息用 {{n2.messageId}}' } },
))

function groupOf(config: { groupId?: string }, session: FlowSession) {
  const id = str(config.groupId) || (session.channel.type === 'group' ? session.channel.id : '')
  if (!id) throw new FlowError('No group: set the group id, or use this node in a group chat')
  return toId(id)
}

function userOf(config: { userId?: string }, session: FlowSession) {
  const id = str(config.userId) || session.user.id
  if (!id) throw new FlowError('No user: set the QQ number')
  return toId(id)
}

function messageOf(config: { messageId?: string }, context: { session: FlowSession; event?: FlowEvent }) {
  const id = str(config.messageId) || context.session.messageId || str(context.event?.data.message_id)
  if (!id) throw new FlowError('No message: set the message id')
  return toId(id)
}

/** Calls the OneBot API; a failed call continues on "failed" with the error instead of stopping the run. */
async function callApi(context: NodeContext<any>, action: string, params: Record<string, any>) {
  const { bot } = context
  if (!bot) throw new FlowError('This node needs a bot; it cannot run here')
  if (bot.platform !== 'onebot' && bot.platform !== 'test') throw new FlowError(`This node needs a OneBot bot, not "${bot.platform}"`)
  try {
    return { ok: true as const, data: await bot.call(action, params) }
  } catch (error) {
    return { ok: false as const, error: String((error as Error)?.message ?? error) }
  }
}

const errorPort = port('error', 'text', 'Error', '错误信息')

/** An action node that makes one API call and continues on "ok" or "failed". */
function apiNode<C>(definition: {
  type: string
  category: NodeCategory
  title: LocalizedText
  description: LocalizedText
  config: z.ZodType<C>
  outputs?: PortDef[]
  inputs?: PortDef[]
  /** Returns the action and its params. */
  request(context: NodeContext<C>): { action: string; params: Record<string, any> }
  /** Turns the response data into outputs; data is null in test runs. */
  result?(data: any, context: NodeContext<C>): Record<string, unknown>
}): NodeType<C> {
  const outputs = [...(definition.outputs ?? []), errorPort]
  const empty = () => Object.fromEntries((definition.outputs ?? []).map((item) => [item.name, item.type === 'number' ? 0 : item.type === 'boolean' ? false : item.type === 'any' ? null : '']))
  return {
    kind: 'action',
    type: definition.type,
    category: definition.category,
    title: definition.title,
    description: definition.description,
    config: definition.config,
    inputs: definition.inputs,
    outputs,
    execOut: ['ok', 'failed'],
    async run(context): Promise<NodeResult> {
      const { action, params } = definition.request(context)
      const response = await callApi(context, action, params)
      if (!response.ok) {
        context.logger.warn('%s failed: %s', action, response.error)
        return { exec: 'failed', outputs: { ...empty(), error: response.error } }
      }
      const values = definition.result?.(response.data ?? null, context) ?? {}
      return { exec: 'ok', outputs: { ...empty(), ...values, error: '' } }
    },
  }
}

// ---- event triggers ----

const groupPorts = [
  port('groupId', 'text', 'Group id', '群号'),
  port('userId', 'text', 'User id', 'QQ 号'),
]
const operatorPort = port('operatorId', 'text', 'Operator id', '操作者 QQ')
const subTypePort = port('subType', 'text', 'Sub type', '子类型')

const isSelf = (data: Record<string, any>, id: unknown) => idOf(id) !== undefined && idOf(id) === idOf(data.self_id)

/** A trigger for one or more named OneBot events; `map` returns the outputs, or nothing to skip the event. */
function eventTrigger<C>(definition: {
  type: string
  title: LocalizedText
  description: LocalizedText
  names: string[]
  config?: z.ZodType<C>
  outputs: PortDef[]
  map(data: Record<string, any>, config: C, event: FlowEvent): Record<string, unknown> | undefined
}): NodeType<C> {
  return {
    kind: 'trigger',
    source: 'event',
    type: definition.type,
    category: 'event',
    title: definition.title,
    description: definition.description,
    config: definition.config,
    outputs: definition.outputs,
    match({ event, config }) {
      if (!event || !definition.names.includes(event.name)) return
      return definition.map(event.data, config, event)
    },
  }
}

const memberJoin = eventTrigger({
  type: 'onebot.memberJoin',
  title: text('Member joined', '成员入群'),
  description: text('A member joined a group (group_increase): approved by an admin, or invited', '有人加入群聊（group_increase）：管理员同意或被邀请'),
  names: ['group_increase'],
  config: z.object({
    subType: z.enum(['any', 'approve', 'invite']).default('any').meta(field('How', 'approve: an admin approved a request. invite: someone invited them.', {
      'zh-CN': { title: '方式', description: 'approve：管理员同意入群申请。invite：被邀请入群。' },
    })),
    includeSelf: z.boolean().default(false).meta(field('Also when the bot joins', undefined, { 'zh-CN': { title: '机器人自己入群时也触发' } })),
  }),
  outputs: [...groupPorts, operatorPort, subTypePort, port('isSelf', 'boolean', 'The bot joined', '是机器人自己')],
  map(data, config) {
    if (config.subType !== 'any' && data.sub_type !== config.subType) return
    const self = isSelf(data, data.user_id)
    if (self && !config.includeSelf) return
    return { groupId: str(data.group_id), userId: str(data.user_id), operatorId: str(data.operator_id), subType: str(data.sub_type), isSelf: self }
  },
})

const memberLeave = eventTrigger({
  type: 'onebot.memberLeave',
  title: text('Member left', '成员离群'),
  description: text('A member left or was removed (group_decrease); kick_me means the bot was removed, disband (NapCat) that the group was dissolved', '有人退群或被移出（group_decrease）；kick_me 表示机器人被踢，disband（NapCat）表示群被解散'),
  names: ['group_decrease'],
  config: z.object({
    subType: z.enum(['any', 'leave', 'kick', 'kick_me', 'disband']).default('any').meta(field('How', 'leave: left on their own. kick: removed by an admin. kick_me: the bot was removed.', {
      'zh-CN': { title: '方式', description: 'leave：主动退群。kick：被管理员移出。kick_me：机器人被移出。disband：群被解散。' },
    })),
  }),
  outputs: [...groupPorts, operatorPort, subTypePort, port('isSelf', 'boolean', 'The bot left', '是机器人自己')],
  map(data, config) {
    if (config.subType !== 'any' && data.sub_type !== config.subType) return
    return {
      groupId: str(data.group_id), userId: str(data.user_id), operatorId: str(data.operator_id), subType: str(data.sub_type),
      isSelf: data.sub_type === 'kick_me' || isSelf(data, data.user_id),
    }
  },
})

const poke = eventTrigger({
  type: 'onebot.poke',
  title: text('Poke', '戳一戳'),
  description: text('Someone poked someone (notify.poke), in a group or a private chat', '有人戳了一戳（notify.poke），群聊或私聊'),
  names: ['notify.poke'],
  config: z.object({
    where: z.enum(['any', 'group', 'private']).default('any').meta(field('Where', undefined, { 'zh-CN': { title: '在哪' } })),
    onlyBot: z.boolean().default(true).meta(field('Only when the bot is poked', undefined, { 'zh-CN': { title: '只在戳机器人时触发' } })),
  }),
  outputs: [
    port('groupId', 'text', 'Group id (empty in private)', '群号（私聊为空）'),
    port('userId', 'text', 'Poked by', '戳人的 QQ'),
    port('targetId', 'text', 'Poked', '被戳的 QQ'),
    port('isPrivate', 'boolean', 'Private chat', '是私聊'),
    port('targetIsBot', 'boolean', 'The bot was poked', '戳的是机器人'),
  ],
  map(data, config) {
    const group = idOf(data.group_id)
    if (config.where === 'group' && !group) return
    if (config.where === 'private' && group) return
    // NapCat: in a private poke user_id is the chat partner and sender_id the poker.
    const from = str(data.sender_id ?? data.user_id)
    const targetIsBot = isSelf(data, data.target_id)
    if (config.onlyBot && !targetIsBot) return
    if (isSelf(data, from)) return
    return { groupId: group ?? '', userId: from, targetId: str(data.target_id), isPrivate: !group, targetIsBot }
  },
})

const recall = eventTrigger({
  type: 'onebot.recall',
  title: text('Message recalled', '消息撤回'),
  description: text('A message was recalled (group_recall, friend_recall). The text comes from the bot\'s message log when it is still there.', '有消息被撤回（group_recall、friend_recall）。原文取自机器人的消息记录，查不到时为空。'),
  names: ['group_recall', 'friend_recall'],
  config: z.object({
    where: z.enum(['any', 'group', 'private']).default('any').meta(field('Where', undefined, { 'zh-CN': { title: '在哪' } })),
    ignoreSelf: z.boolean().default(true).meta(field('Ignore the bot\'s own recalls', undefined, { 'zh-CN': { title: '忽略机器人自己的撤回' } })),
  }),
  outputs: [
    port('groupId', 'text', 'Group id (empty in private)', '群号（私聊为空）'),
    port('userId', 'text', 'Author', '消息发送者'),
    operatorPort,
    port('messageId', 'text', 'Message id', '消息 ID'),
    port('text', 'text', 'Recalled text', '撤回的内容'),
    port('message', 'message', 'Recalled message', '撤回的消息'),
    port('byAdmin', 'boolean', 'Recalled by someone else', '被他人撤回'),
  ],
  map(data, config, event) {
    const group = event.name === 'group_recall'
    if (config.where === 'group' && !group) return
    if (config.where === 'private' && group) return
    // friend_recall has no operator: the author recalled it.
    const operator = str(data.operator_id ?? data.user_id)
    if (config.ignoreSelf && isSelf(data, operator)) return
    return {
      groupId: group ? str(data.group_id) : '', userId: str(data.user_id), operatorId: operator, messageId: str(data.message_id),
      text: event.message?.text ?? '', message: event.message?.segments ?? [], byAdmin: operator !== str(data.user_id),
    }
  },
})

const groupBan = eventTrigger({
  type: 'onebot.groupBan',
  title: text('Mute changed', '禁言变化'),
  description: text('A member was muted or unmuted (group_ban); a whole-group mute has no member', '有人被禁言或解除禁言（group_ban）；全员禁言时没有成员'),
  names: ['group_ban'],
  config: z.object({
    subType: z.enum(['any', 'ban', 'lift_ban']).default('any').meta(field('Change', 'ban: muted. lift_ban: unmuted.', {
      'zh-CN': { title: '变化', description: 'ban：禁言。lift_ban：解除禁言。' },
    })),
  }),
  outputs: [...groupPorts, operatorPort, subTypePort, port('duration', 'number', 'Seconds', '时长（秒）'), port('wholeGroup', 'boolean', 'Whole group', '全员禁言')],
  map(data, config) {
    if (config.subType !== 'any' && data.sub_type !== config.subType) return
    return {
      groupId: str(data.group_id), userId: idOf(data.user_id) ?? '', operatorId: str(data.operator_id), subType: str(data.sub_type),
      duration: Number(data.duration) || 0, wholeGroup: !idOf(data.user_id),
    }
  },
})

const groupAdmin = eventTrigger({
  type: 'onebot.groupAdmin',
  title: text('Admin changed', '管理员变动'),
  description: text('A member became or stopped being an admin (group_admin)', '有人被设为或取消管理员（group_admin）'),
  names: ['group_admin'],
  config: z.object({
    subType: z.enum(['any', 'set', 'unset']).default('any').meta(field('Change', undefined, { 'zh-CN': { title: '变化' } })),
  }),
  outputs: [...groupPorts, subTypePort],
  map(data, config) {
    if (config.subType !== 'any' && data.sub_type !== config.subType) return
    return { groupId: str(data.group_id), userId: str(data.user_id), subType: str(data.sub_type) }
  },
})

const groupUpload = eventTrigger({
  type: 'onebot.groupUpload',
  title: text('File uploaded', '群文件上传'),
  description: text('Someone uploaded a group file (group_upload)', '有人上传了群文件（group_upload）'),
  names: ['group_upload'],
  outputs: [
    ...groupPorts,
    port('fileName', 'text', 'File name', '文件名'),
    port('fileSize', 'number', 'Size (bytes)', '大小（字节）'),
    port('fileId', 'text', 'File id', '文件 ID'),
    port('busid', 'number', 'busid', 'busid'),
  ],
  map(data) {
    const file = data.file ?? {}
    return { groupId: str(data.group_id), userId: str(data.user_id), fileName: str(file.name), fileSize: Number(file.size) || 0, fileId: str(file.id), busid: Number(file.busid) || 0 }
  },
})

const friendAdd = eventTrigger({
  type: 'onebot.friendAdd',
  title: text('New friend', '新好友'),
  description: text('Someone became the bot\'s friend (friend_add)', '有人成为机器人的好友（friend_add）'),
  names: ['friend_add'],
  outputs: [port('userId', 'text', 'User id', 'QQ 号')],
  map: (data) => ({ userId: str(data.user_id) }),
})

const flagPort = port('flag', 'text', 'Request flag', '请求 flag')
const commentPort = port('comment', 'text', 'Message', '验证消息')

const friendRequest = eventTrigger({
  type: 'onebot.friendRequest',
  title: text('Friend request', '加好友请求'),
  description: text('Someone asks to add the bot as a friend (request.friend). Answer with "Handle request".', '有人申请添加机器人为好友（request.friend）。用“处理请求”节点同意或拒绝。'),
  names: ['request.friend'],
  outputs: [port('userId', 'text', 'User id', 'QQ 号'), commentPort, flagPort],
  map: (data) => ({ userId: str(data.user_id), comment: str(data.comment), flag: str(data.flag) }),
})

const groupRequest = eventTrigger({
  type: 'onebot.groupRequest',
  title: text('Group request', '加群请求 / 邀请'),
  description: text('Someone asks to join a group the bot manages (add), or invites the bot to a group (invite). Answer with "Handle request".', '有人申请加入机器人管理的群（add），或邀请机器人入群（invite）（request.group）。用“处理请求”节点同意或拒绝。'),
  names: ['request.group'],
  config: z.object({
    subType: z.enum(['any', 'add', 'invite']).default('any').meta(field('Kind', 'add: a join request. invite: the bot is invited.', {
      'zh-CN': { title: '类型', description: 'add：入群申请。invite：邀请机器人入群。' },
    })),
  }),
  outputs: [...groupPorts, commentPort, flagPort, subTypePort],
  map(data, config) {
    if (config.subType !== 'any' && data.sub_type !== config.subType) return
    return { groupId: str(data.group_id), userId: str(data.user_id), comment: str(data.comment), flag: str(data.flag), subType: str(data.sub_type) }
  },
})

const GROUP_CHANGES: Record<string, string> = {
  group_card: 'card',
  'notify.group_name': 'name',
  'notify.title': 'title',
  essence: 'essence',
  group_msg_emoji_like: 'emojiLike',
}

const groupChange = eventTrigger({
  type: 'onebot.groupChange',
  title: text('Group info changed', '群资料变化'),
  description: text(
    'NapCat: a member card (group_card), the group name (notify.group_name), a member title (notify.title), essence messages (essence) or a reaction (group_msg_emoji_like) changed',
    'NapCat：群名片（group_card）、群名（notify.group_name）、专属头衔（notify.title）、精华消息（essence）或表情回应（group_msg_emoji_like）发生变化',
  ),
  names: Object.keys(GROUP_CHANGES),
  config: z.object({
    kind: z.enum(['any', 'card', 'name', 'title', 'essence', 'emojiLike']).default('any').meta(field('What', undefined, { 'zh-CN': { title: '哪种变化' } })),
  }),
  outputs: [
    port('kind', 'text', 'What changed (card / name / title / essence / emojiLike)', '变化类型（card / name / title / essence / emojiLike）'),
    ...groupPorts,
    operatorPort,
    port('before', 'text', 'Before', '原来的值'),
    port('after', 'text', 'After', '新的值'),
    port('messageId', 'text', 'Message id', '消息 ID'),
    port('emojiId', 'text', 'Emoji id', '表情 ID'),
    port('added', 'boolean', 'Added (essence / reaction)', '是添加（精华 / 回应）'),
  ],
  map(data, config, event) {
    const kind = GROUP_CHANGES[event.name]
    if (config.kind !== 'any' && config.kind !== kind) return
    const like = Array.isArray(data.likes) ? data.likes[0] : undefined
    return {
      kind,
      groupId: str(data.group_id),
      userId: str(data.user_id ?? data.sender_id),
      operatorId: str(data.operator_id),
      before: kind === 'card' ? str(data.card_old) : '',
      after: kind === 'card' ? str(data.card_new) : kind === 'name' ? str(data.name_new) : kind === 'title' ? str(data.title) : '',
      messageId: str(data.message_id),
      emojiId: str(like?.emoji_id),
      added: kind === 'essence' ? data.sub_type !== 'delete' : kind === 'emojiLike' ? data.is_add !== false : false,
    }
  },
})

const honor = eventTrigger({
  type: 'onebot.honor',
  title: text('Group honor / lucky king', '群荣誉 / 运气王'),
  description: text(
    'OneBot 11: a member got a group honor (notify.honor) or was the red packet lucky king (notify.lucky_king). NapCat does not report these.',
    'OneBot 11：成员获得群荣誉（notify.honor）或成为红包运气王（notify.lucky_king）。NapCat 不上报这两种事件。',
  ),
  names: ['notify.honor', 'notify.lucky_king'],
  outputs: [
    port('kind', 'text', 'honor / lucky_king', 'honor / lucky_king'),
    ...groupPorts,
    port('honorType', 'text', 'Honor (talkative / performer / emotion)', '荣誉（talkative 龙王 / performer 群聊之火 / emotion 快乐源泉）'),
    port('targetId', 'text', 'Lucky king', '运气王'),
  ],
  map: (data, _config, event) => ({
    kind: event.name.slice('notify.'.length),
    groupId: str(data.group_id),
    userId: str(data.user_id),
    honorType: str(data.honor_type),
    targetId: str(data.target_id),
  }),
})

const anyEvent: NodeType = {
  kind: 'trigger',
  source: 'event',
  type: 'onebot.event',
  category: 'event',
  title: text('Any OneBot event', '任意 OneBot 事件'),
  description: text(
    'Any notice or request, filtered by name: notice_type (e.g. group_card), notify.<sub_type> (e.g. notify.profile_like, notify.input_status) or request.<request_type>. Outputs the whole event.',
    '任意通知或请求，按名称过滤：notice_type（如 group_card）、notify.<sub_type>（如 notify.profile_like、notify.input_status）或 request.<request_type>。输出整个事件。',
  ),
  config: z.object({
    names: z.array(z.string()).default([]).meta(field('Event names', 'Empty matches every event', {
      'zh-CN': { title: '事件名称', description: '留空则匹配所有事件' },
    })),
    subType: z.string().default('').meta(field('sub_type', 'Empty matches any', { 'zh-CN': { title: 'sub_type', description: '留空则不限' } })),
  }),
  outputs: [
    port('name', 'text', 'Event name', '事件名称'),
    port('subType', 'text', 'sub_type', 'sub_type'),
    port('groupId', 'text', 'Group id', '群号'),
    port('userId', 'text', 'User id', 'QQ 号'),
    port('data', 'any', 'Event', '事件数据'),
    port('json', 'text', 'Event (JSON)', '事件 JSON'),
  ],
  match({ event, config }) {
    if (!event) return
    const names = (config.names as string[]).map((name) => name.trim()).filter(Boolean)
    if (names.length && !names.includes(event.name)) return
    if (config.subType && str(event.data.sub_type) !== config.subType) return
    return {
      name: event.name,
      subType: str(event.data.sub_type),
      groupId: idOf(event.data.group_id) ?? '',
      userId: idOf(event.data.user_id) ?? '',
      data: event.data,
      json: JSON.stringify(event.data),
    }
  },
}

// ---- group management ----

const muteNode = apiNode({
  type: 'onebot.mute',
  category: 'manage',
  title: text('Mute member', '禁言 / 解禁'),
  description: text('Mutes a group member for some seconds; 0 unmutes (set_group_ban)', '禁言群成员若干秒，0 为解除禁言（set_group_ban）'),
  config: z.object({
    groupId: groupIdField,
    userId: userIdField,
    seconds: z.number().int().min(0).max(30 * 24 * 3600).default(600).meta(field('Seconds', '0 unmutes; at most 30 days. The "seconds" input overrides it.', {
      'zh-CN': { title: '秒数', description: '0 为解除禁言；最长 30 天。设置了“秒数”输入时以输入为准。' },
    })),
  }),
  inputs: [port('seconds', 'number', 'Seconds', '秒数')],
  request: ({ config, inputs, session }) => ({
    action: 'set_group_ban',
    params: { group_id: groupOf(config, session), user_id: userOf(config, session), duration: Math.max(0, Math.round(inputs.seconds ?? config.seconds)) },
  }),
})

const muteAllNode = apiNode({
  type: 'onebot.muteAll',
  category: 'manage',
  title: text('Mute everyone', '全员禁言'),
  description: text('Turns the whole-group mute on or off (set_group_whole_ban)', '开启或关闭全员禁言（set_group_whole_ban）'),
  config: z.object({
    groupId: groupIdField,
    enable: z.boolean().default(true).meta(field('On', undefined, { 'zh-CN': { title: '开启' } })),
  }),
  request: ({ config, session }) => ({ action: 'set_group_whole_ban', params: { group_id: groupOf(config, session), enable: config.enable } }),
})

const kickNode = apiNode({
  type: 'onebot.kick',
  category: 'manage',
  title: text('Remove member', '踢出成员'),
  description: text('Removes members from the group (set_group_kick; several at once with NapCat\'s set_group_kick_members)', '把成员移出群（set_group_kick；多人时用 NapCat 的 set_group_kick_members）'),
  config: z.object({
    groupId: groupIdField,
    userIds: z.string().default('').meta(field('Users', 'QQ numbers separated by spaces or commas; empty removes the sender', {
      'zh-CN': { title: 'QQ 号', description: '多个用空格或逗号分隔；留空则移出发送者' },
    })),
    rejectAdd: z.boolean().default(false).meta(field('Reject later join requests', undefined, { 'zh-CN': { title: '拒绝此人再次加群' } })),
  }),
  outputs: [port('count', 'number', 'Removed', '移出人数')],
  request({ config, session }) {
    const ids = str(config.userIds).split(/[\s,，]+/).filter(Boolean)
    const list = ids.length ? ids : [String(userOf({}, session))]
    const group = groupOf(config, session)
    if (list.length === 1) return { action: 'set_group_kick', params: { group_id: group, user_id: toId(list[0]), reject_add_request: config.rejectAdd } }
    return { action: 'set_group_kick_members', params: { group_id: group, user_id: list, reject_add_request: config.rejectAdd } }
  },
  result: (_data, { config, session }) => ({ count: str(config.userIds).split(/[\s,，]+/).filter(Boolean).length || (session.user.id ? 1 : 0) }),
})

const setAdminNode = apiNode({
  type: 'onebot.setAdmin',
  category: 'manage',
  title: text('Set admin', '设置管理员'),
  description: text('Makes a member an admin or removes the role; the bot must be the group owner (set_group_admin)', '设置或取消管理员，机器人需要是群主（set_group_admin）'),
  config: z.object({
    groupId: groupIdField,
    userId: userIdField,
    enable: z.boolean().default(true).meta(field('Make admin', 'Off removes the role', { 'zh-CN': { title: '设为管理员', description: '关闭则取消管理员' } })),
  }),
  request: ({ config, session }) => ({ action: 'set_group_admin', params: { group_id: groupOf(config, session), user_id: userOf(config, session), enable: config.enable } }),
})

const setCardNode = apiNode({
  type: 'onebot.setCard',
  category: 'manage',
  title: text('Set member card', '设置群名片'),
  description: text('Sets a member\'s group card; empty clears it (set_group_card)', '设置成员的群名片，留空为清除（set_group_card）'),
  config: z.object({
    groupId: groupIdField,
    userId: userIdField,
    card: z.string().default('').meta(field('Card', 'Supports references', { 'zh-CN': { title: '群名片', description: '支持变量引用' } })),
  }),
  request: ({ config, session }) => ({ action: 'set_group_card', params: { group_id: groupOf(config, session), user_id: userOf(config, session), card: str(config.card) } }),
})

const setTitleNode = apiNode({
  type: 'onebot.setTitle',
  category: 'manage',
  title: text('Set special title', '设置专属头衔'),
  description: text('Sets a member\'s special title; the bot must be the group owner (set_group_special_title)', '设置成员的专属头衔，机器人需要是群主（set_group_special_title）'),
  config: z.object({
    groupId: groupIdField,
    userId: userIdField,
    title: z.string().default('').meta(field('Title', 'Empty removes it', { 'zh-CN': { title: '头衔', description: '留空为删除' } })),
  }),
  request: ({ config, session }) => ({
    action: 'set_group_special_title',
    // duration -1 is "forever" in the spec; NapCat ignores it.
    params: { group_id: groupOf(config, session), user_id: userOf(config, session), special_title: str(config.title), duration: -1 },
  }),
})

const setGroupNameNode = apiNode({
  type: 'onebot.setGroupName',
  category: 'manage',
  title: text('Rename group', '修改群名'),
  description: text('Changes the group name (set_group_name)', '修改群名称（set_group_name）'),
  config: z.object({
    groupId: groupIdField,
    name: z.string().min(1).default('New name').meta(field('Name', undefined, { 'zh-CN': { title: '群名' } })),
  }),
  request: ({ config, session }) => ({ action: 'set_group_name', params: { group_id: groupOf(config, session), group_name: str(config.name) } }),
})

const groupNoticeNode = apiNode({
  type: 'onebot.groupNotice',
  category: 'manage',
  title: text('Post announcement', '发布群公告'),
  description: text('Posts a group announcement (NapCat _send_group_notice)', '发布群公告（NapCat _send_group_notice）'),
  config: z.object({
    groupId: groupIdField,
    content: z.string().default('').meta(field('Text', 'Used when the input is not set', { 'zh-CN': { title: '内容', description: '未设置输入时使用' } })),
    image: z.string().default('').meta(field('Image', 'Path or URL; optional', { 'zh-CN': { title: '图片', description: '路径或 URL，可不填' } })),
    pinned: z.boolean().default(false).meta(field('Pin', undefined, { 'zh-CN': { title: '置顶' } })),
    confirm: z.boolean().default(false).meta(field('Members must confirm', undefined, { 'zh-CN': { title: '需要群成员确认' } })),
  }),
  inputs: [port('content', 'text', 'Text', '内容')],
  request({ config, inputs, session }) {
    const content = str(inputs.content) || str(config.content)
    if (!content) throw new FlowError('The announcement is empty')
    return {
      action: '_send_group_notice',
      params: { group_id: groupOf(config, session), content, ...(str(config.image) ? { image: str(config.image) } : {}), pinned: config.pinned ? 1 : 0, confirm_required: config.confirm ? 1 : 0 },
    }
  },
})

const essenceNode = apiNode({
  type: 'onebot.essence',
  category: 'manage',
  title: text('Essence message', '设精华 / 取消精华'),
  description: text('Adds a message to the group\'s essence list or removes it (set_essence_msg / delete_essence_msg)', '把消息设为精华或移出精华（set_essence_msg / delete_essence_msg）'),
  config: z.object({
    messageId: messageIdField,
    remove: z.boolean().default(false).meta(field('Remove instead', undefined, { 'zh-CN': { title: '改为取消精华' } })),
  }),
  request: (context) => ({ action: context.config.remove ? 'delete_essence_msg' : 'set_essence_msg', params: { message_id: messageOf(context.config, context) } }),
})

const groupSignNode = apiNode({
  type: 'onebot.groupSign',
  category: 'manage',
  title: text('Group check-in', '群打卡'),
  description: text('The bot checks in to the group (NapCat set_group_sign)', '机器人在群里打卡（NapCat set_group_sign）'),
  config: z.object({ groupId: groupIdField }),
  request: ({ config, session }) => ({ action: 'set_group_sign', params: { group_id: groupOf(config, session) } }),
})

const leaveGroupNode = apiNode({
  type: 'onebot.leaveGroup',
  category: 'manage',
  title: text('Leave group (dangerous)', '退出 / 解散群（危险）'),
  description: text('The bot leaves the group; as the owner it can dissolve it instead (set_group_leave). This cannot be undone.', '机器人退出该群；是群主时可以改为解散（set_group_leave）。无法撤销。'),
  config: z.object({
    groupId: groupIdField,
    dismiss: z.boolean().default(false).meta(field('Dissolve the group (owner only)', undefined, { 'zh-CN': { title: '解散群（仅群主）' } })),
  }),
  request: ({ config, session }) => ({ action: 'set_group_leave', params: { group_id: groupOf(config, session), is_dismiss: config.dismiss } }),
})

// ---- messages and interaction ----

const deleteMsgNode = apiNode({
  type: 'onebot.deleteMsg',
  category: 'platform',
  title: text('Recall message', '撤回消息'),
  description: text('Recalls a message: the one that started the run, or one the bot sent (delete_msg)', '撤回消息：默认撤回触发本次运行的消息，也可以撤回机器人发出的消息（delete_msg）'),
  config: z.object({ messageId: messageIdField }),
  request: (context) => ({ action: 'delete_msg', params: { message_id: messageOf(context.config, context) } }),
})

function segmentsOf(message: unknown): Segment[] {
  if (Array.isArray(message)) return message.map((item: any) => ({ type: String(item?.type), data: item?.data ?? {} }))
  if (typeof message === 'string') return [{ type: 'text', data: { text: message } }]
  return []
}

const getMsgNode = apiNode({
  type: 'onebot.getMsg',
  category: 'platform',
  title: text('Get message', '获取消息'),
  description: text('Reads a message by id, e.g. the one a reply quotes (get_msg)', '按 ID 读取一条消息，例如被引用的消息（get_msg）'),
  config: z.object({ messageId: messageIdField }),
  outputs: [
    port('text', 'text', 'Text', '文本'),
    port('message', 'message', 'Message', '消息内容'),
    port('userId', 'text', 'Sender id', '发送者 QQ'),
    port('userName', 'text', 'Sender', '发送者'),
    port('time', 'number', 'Sent at (Unix seconds)', '发送时间（Unix 秒）'),
    port('data', 'any', 'Response', '完整返回'),
  ],
  request: (context) => ({ action: 'get_msg', params: { message_id: messageOf(context.config, context) } }),
  result(data) {
    if (!data) return {}
    const segments = segmentsOf(data.message)
    const textOf = segments.filter((item) => item.type === 'text').map((item) => String(item.data.text ?? '')).join('') || str(data.raw_message)
    return {
      text: textOf, message: segments, userId: str(data.user_id ?? data.sender?.user_id), userName: str(data.sender?.card || data.sender?.nickname),
      time: Number(data.time) || 0, data,
    }
  },
})

const forwardNode = apiNode({
  type: 'onebot.forward',
  category: 'platform',
  title: text('Send forward message', '发送合并转发'),
  description: text('Sends several texts as one forward message (send_group_forward_msg / send_private_forward_msg)', '把多段文本作为一条合并转发发出（send_group_forward_msg / send_private_forward_msg）'),
  config: z.object({
    targetType: z.enum(['current', 'group', 'private']).default('current').meta(field('Send to', undefined, { 'zh-CN': { title: '发送到' } })),
    targetId: z.string().default('').meta(field('Group or user id', undefined, { 'zh-CN': { title: '群号或 QQ' } })),
    texts: z.array(z.string()).default(['']).meta(field('Messages', 'One forward node each; supports references', { 'zh-CN': { title: '消息', description: '每段一个转发节点；支持变量引用' } })),
    name: z.string().default('').meta(field('Shown sender name', 'Empty uses the bot\'s name', { 'zh-CN': { title: '显示的发送者名称', description: '留空使用机器人名称' } })),
  }),
  inputs: [port('text', 'text', 'Extra message', '追加一段')],
  outputs: [port('messageId', 'text', 'Message id', '消息 ID'), port('forwardId', 'text', 'Forward id', '转发 ID')],
  request({ config, inputs, session, bot }) {
    const channel = resolveTarget(config, session.channel)
    if (!channel) throw new FlowError('Set the group or user id to send to')
    const texts = [...(config.texts as string[]), str(inputs.text)].map(str).filter(Boolean)
    if (!texts.length) throw new FlowError('The forward message has no text')
    const uin = bot?.selfId ? toId(bot.selfId) : undefined
    const name = str(config.name) || 'Bot'
    // NapCat reads user_id/nickname; go-cqhttp style uin/name are sent too.
    const messages = texts.map((value) => ({ type: 'node', data: { user_id: uin, uin, nickname: name, name, content: [{ type: 'text', data: { text: value } }] } }))
    return channel.type === 'group'
      ? { action: 'send_group_forward_msg', params: { group_id: toId(channel.id), messages } }
      : { action: 'send_private_forward_msg', params: { user_id: toId(channel.id), messages } }
  },
  result: (data) => ({ messageId: str(data?.message_id), forwardId: str(data?.res_id ?? data?.forward_id) }),
})

const pokeNode = apiNode({
  type: 'onebot.sendPoke',
  category: 'platform',
  title: text('Poke', '戳一戳'),
  description: text('Pokes someone in a group or a private chat (NapCat group_poke / friend_poke)', '在群里或私聊戳一戳某人（NapCat group_poke / friend_poke）'),
  config: z.object({
    where: z.enum(['current', 'group', 'private']).default('current').meta(field('Where', 'current: the chat the run is about', { 'zh-CN': { title: '在哪', description: 'current：本次运行所在的会话' } })),
    groupId: groupIdField,
    userId: userIdField,
  }),
  request({ config, session }) {
    const inGroup = config.where === 'group' || (config.where === 'current' && session.channel.type === 'group')
    const user = userOf(config, session)
    return inGroup
      ? { action: 'group_poke', params: { group_id: groupOf(config, session), user_id: user } }
      : { action: 'friend_poke', params: { user_id: user } }
  },
})

const emojiLikeNode = apiNode({
  type: 'onebot.emojiLike',
  category: 'platform',
  title: text('React with emoji', '表情回应'),
  description: text('Adds or removes an emoji reaction on a group message (NapCat set_msg_emoji_like)', '给群消息添加或取消表情回应（NapCat set_msg_emoji_like）'),
  config: z.object({
    messageId: messageIdField,
    emojiId: z.string().min(1).default('76').meta(field('Emoji id', 'QQ face id, e.g. 76 (thumbs up), 66 (heart)', {
      'zh-CN': { title: '表情 ID', description: 'QQ 表情 ID，例如 76（赞）、66（爱心）' },
    })),
    remove: z.boolean().default(false).meta(field('Remove instead', undefined, { 'zh-CN': { title: '改为取消回应' } })),
  }),
  request: (context) => ({
    action: 'set_msg_emoji_like',
    params: { message_id: messageOf(context.config, context), emoji_id: toId(str(context.config.emojiId)), set: !context.config.remove },
  }),
})

const likeNode = apiNode({
  type: 'onebot.like',
  category: 'platform',
  title: text('Like profile', '资料卡点赞'),
  description: text('Likes someone\'s profile card (send_like); QQ allows 10 a day per person, 20 for SVIP', '给某人的资料卡点赞（send_like）；QQ 每人每天最多 10 次，SVIP 20 次'),
  config: z.object({
    userId: userIdField,
    times: z.number().int().min(1).max(20).default(10).meta(field('Times', undefined, { 'zh-CN': { title: '次数' } })),
  }),
  request: ({ config, session }) => ({ action: 'send_like', params: { user_id: userOf(config, session), times: config.times } }),
})

const handleRequestNode = apiNode({
  type: 'onebot.handleRequest',
  category: 'platform',
  title: text('Handle request', '处理请求'),
  description: text(
    'Approves or rejects the friend or group request that started the run (set_friend_add_request / set_group_add_request); flag and sub_type come from the event',
    '同意或拒绝触发本次运行的好友或加群请求（set_friend_add_request / set_group_add_request）；flag 和 sub_type 取自事件',
  ),
  config: z.object({
    approve: z.boolean().default(true).meta(field('Approve', 'Off rejects', { 'zh-CN': { title: '同意', description: '关闭则拒绝' } })),
    remark: z.string().default('').meta(field('Friend remark', 'Friend requests, when approving', { 'zh-CN': { title: '好友备注', description: '同意好友请求时使用' } })),
    reason: z.string().default('').meta(field('Reason for rejecting', 'Group requests', { 'zh-CN': { title: '拒绝理由', description: '拒绝加群请求时使用' } })),
    flag: z.string().default('').meta(field('Flag', 'Empty uses the request that started the run', { 'zh-CN': { title: 'flag', description: '留空则使用触发本次运行的请求' } })),
    kind: z.enum(['auto', 'friend', 'add', 'invite']).default('auto').meta(field('Request kind', 'auto: from the event. Set it when passing a flag by hand.', {
      'zh-CN': { title: '请求类型', description: 'auto：取自事件。手动填 flag 时需要设置。' },
    })),
  }),
  request({ config, event }) {
    const flag = str(config.flag) || str(event?.data.flag)
    if (!flag) throw new FlowError('No request: start the flow with a friend or group request trigger, or set the flag')
    const kind = config.kind !== 'auto' ? config.kind
      : event?.name === 'request.friend' ? 'friend'
      : event?.name === 'request.group' ? str(event.data.sub_type) || 'add'
      : ''
    if (!kind) throw new FlowError('Set the request kind: the run was not started by a request')
    if (kind === 'friend') {
      return { action: 'set_friend_add_request', params: { flag, approve: config.approve, ...(config.approve && str(config.remark) ? { remark: str(config.remark) } : {}) } }
    }
    // The spec names it sub_type (go-cqhttp also reads type); NapCat finds the request by flag alone.
    return {
      action: 'set_group_add_request',
      params: { flag, sub_type: kind, type: kind, approve: config.approve, ...(!config.approve && str(config.reason) ? { reason: str(config.reason) } : {}) },
    }
  },
})

// ---- queries ----

const ROLES = ['owner', 'admin', 'member']

const memberInfoNode = apiNode({
  type: 'onebot.memberInfo',
  category: 'platform',
  title: text('Member info', '群成员信息'),
  description: text('Reads a group member\'s card, role, title and activity (get_group_member_info)', '读取群成员的名片、身份、头衔和活跃信息（get_group_member_info）'),
  config: z.object({
    groupId: groupIdField,
    userId: userIdField,
    noCache: z.boolean().default(false).meta(field('Skip the cache', undefined, { 'zh-CN': { title: '不使用缓存' } })),
  }),
  outputs: [
    port('name', 'text', 'Display name (card or nickname)', '显示名（名片或昵称）'),
    port('card', 'text', 'Card', '群名片'),
    port('nickname', 'text', 'Nickname', '昵称'),
    port('role', 'text', 'Role (owner / admin / member)', '身份（owner / admin / member）'),
    port('title', 'text', 'Special title', '专属头衔'),
    port('level', 'text', 'Group level', '群等级'),
    port('joinTime', 'number', 'Joined (Unix seconds)', '入群时间（Unix 秒）'),
    port('lastSentTime', 'number', 'Last spoke (Unix seconds)', '最后发言（Unix 秒）'),
    port('data', 'any', 'Response', '完整返回'),
  ],
  request: ({ config, session }) => ({ action: 'get_group_member_info', params: { group_id: groupOf(config, session), user_id: userOf(config, session), no_cache: config.noCache } }),
  result: (data) => (data
    ? {
        name: str(data.card) || str(data.nickname), card: str(data.card), nickname: str(data.nickname), role: str(data.role), title: str(data.title),
        level: str(data.level), joinTime: Number(data.join_time) || 0, lastSentTime: Number(data.last_sent_time) || 0, data,
      }
    : {}),
})

const userInfoNode = apiNode({
  type: 'onebot.userInfo',
  category: 'platform',
  title: text('User info', '用户信息'),
  description: text('Reads anyone\'s public profile (get_stranger_info)', '读取任意 QQ 用户的公开资料（get_stranger_info）'),
  config: z.object({
    userId: userIdField,
    noCache: z.boolean().default(false).meta(field('Skip the cache', undefined, { 'zh-CN': { title: '不使用缓存' } })),
  }),
  outputs: [
    port('nickname', 'text', 'Nickname', '昵称'),
    port('sex', 'text', 'Sex (male / female / unknown)', '性别（male / female / unknown）'),
    port('age', 'number', 'Age', '年龄'),
    port('level', 'number', 'QQ level', 'QQ 等级'),
    port('signature', 'text', 'Signature', '个性签名'),
    port('data', 'any', 'Response', '完整返回'),
  ],
  request: ({ config, session }) => ({ action: 'get_stranger_info', params: { user_id: userOf(config, session), no_cache: config.noCache } }),
  result: (data) => (data
    ? { nickname: str(data.nickname), sex: str(data.sex), age: Number(data.age) || 0, level: Number(data.qqLevel ?? data.level) || 0, signature: str(data.long_nick), data }
    : {}),
})

const groupInfoNode = apiNode({
  type: 'onebot.groupInfo',
  category: 'platform',
  title: text('Group info', '群信息'),
  description: text('Reads a group\'s name and member count (get_group_info)', '读取群名称和人数（get_group_info）'),
  config: z.object({
    groupId: groupIdField,
    noCache: z.boolean().default(false).meta(field('Skip the cache', undefined, { 'zh-CN': { title: '不使用缓存' } })),
  }),
  outputs: [
    port('name', 'text', 'Name', '群名'),
    port('memberCount', 'number', 'Members', '成员数'),
    port('maxMemberCount', 'number', 'Member limit', '成员上限'),
    port('data', 'any', 'Response', '完整返回'),
  ],
  request: ({ config, session }) => ({ action: 'get_group_info', params: { group_id: groupOf(config, session), no_cache: config.noCache } }),
  result: (data) => (data ? { name: str(data.group_name), memberCount: Number(data.member_count) || 0, maxMemberCount: Number(data.max_member_count) || 0, data } : {}),
})

const senderRoleNode: NodeType = {
  kind: 'action',
  type: 'onebot.senderRole',
  category: 'platform',
  title: text('Sender role', '发送者身份'),
  description: text(
    'Branches on who sent the message: "master" for the QQ numbers listed here, then the group owner, admins and members. In private chats everyone but a master is "member".',
    '按发送者身份分支：这里列出的 QQ 走 master，其余按群主 owner、管理员 admin、成员 member。私聊中除 master 外都走 member。',
  ),
  config: z.object({
    masters: z.array(z.string()).default([]).meta(field('Masters', 'QQ numbers that always count as master', { 'zh-CN': { title: '主人', description: '始终视为 master 的 QQ 号' } })),
  }),
  outputs: [port('role', 'text', 'Role', '身份')],
  execOut: ['master', ...ROLES],
  async run(context) {
    const { config, session } = context
    if ((config.masters as string[]).map(str).includes(session.user.id)) return { exec: 'master', outputs: { role: 'master' } }
    if (session.channel.type !== 'group') return { exec: 'member', outputs: { role: 'member' } }
    let role: string | undefined = session.user.role
    // Events carry no sender role; ask NapCat.
    if (!role && session.user.id) {
      const response = await callApi(context, 'get_group_member_info', { group_id: toId(session.channel.id), user_id: toId(session.user.id) })
      if (response.ok) role = str(response.data?.role)
    }
    const exec = role && ROLES.includes(role) ? role : 'member'
    return { exec, outputs: { role: exec } }
  },
}

const callApiNode: NodeType = {
  kind: 'action',
  type: 'onebot.call',
  category: 'platform',
  title: text('Call OneBot API', '调用 OneBot 接口'),
  description: text(
    'Calls any OneBot 11 or NapCat API with JSON params, e.g. get_group_honor_info, upload_group_file, get_group_msg_history',
    '用 JSON 参数调用任意 OneBot 11 或 NapCat 接口，例如 get_group_honor_info、upload_group_file、get_group_msg_history',
  ),
  config: z.object({
    action: z.string().min(1).default('get_status').meta(field('API', 'Action name', { 'zh-CN': { title: '接口', description: '接口名（action）' } })),
    params: z.string().default('{}').meta(field('Params (JSON)', 'Supports references, e.g. {"group_id": {{sys.groupId}}}', {
      'zh-CN': { title: '参数（JSON）', description: '支持变量引用，例如 {"group_id": {{sys.groupId}}}' },
    })),
  }),
  outputs: [port('data', 'any', 'Response data', '返回数据'), port('json', 'text', 'Response (JSON)', '返回 JSON'), errorPort],
  execOut: ['ok', 'failed'],
  async run(context) {
    const { config } = context
    let params: Record<string, any>
    try {
      const parsed = JSON.parse(str(config.params) || '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      params = parsed
    } catch (error) {
      throw new FlowError(`Params are not a JSON object: ${(error as Error).message}`)
    }
    const response = await callApi(context, str(config.action), params)
    if (!response.ok) return { exec: 'failed', outputs: { data: null, json: '', error: response.error } }
    return { exec: 'ok', outputs: { data: response.data ?? null, json: JSON.stringify(response.data ?? null), error: '' } }
  },
}

/** Every OneBot node; they only work on OneBot bots, so the editor greys them out for other adapters. */
export const onebotNodes: NodeType[] = ([
  memberJoin, memberLeave, poke, recall, groupBan, groupAdmin, groupUpload, friendAdd, friendRequest, groupRequest, groupChange, honor, anyEvent,
  muteNode, muteAllNode, kickNode, setAdminNode, setCardNode, setTitleNode, setGroupNameNode, groupNoticeNode, essenceNode, groupSignNode, leaveGroupNode,
  deleteMsgNode, getMsgNode, forwardNode, pokeNode, emojiLikeNode, likeNode, handleRequestNode,
  memberInfoNode, userInfoNode, groupInfoNode, senderRoleNode, callApiNode,
] as NodeType[]).map((node) => ({ ...node, platforms: ['onebot'] }))
