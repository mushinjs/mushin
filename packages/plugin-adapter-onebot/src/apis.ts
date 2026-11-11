import type { LocalizedText } from '@mushinjs/core'

/**
 * The params of OneBot 11 APIs and of NapCat's extensions, for the "Call OneBot API" node: the
 * node checks params against it before calling, and the editor shows one field per param.
 *
 * Standard APIs follow the OneBot 11 spec (github.com/botuniverse/onebot-11, api/public.md): a
 * param whose default is "-" there is required. NapCat's own APIs (`source: 'napcat'`, such as
 * `send_poke`, which OneBot 11 does not have) follow NapCat's API docs
 * (napneko.github.io/develop/api/doc) and the action schemas in its source
 * (NapNeko/NapCatQQ, packages/napcat-onebot/action). APIs not listed are called as written.
 */

/**
 * `int` is a whole number: QQ, group and message ids (int64 / int32 in the spec), counts and
 * seconds. Numeric text is accepted and converted, as NapCat accepts both. `int`, `boolean` and
 * params with `options` hold one value: one literal or one reference.
 */
export type ApiParamType = 'int' | 'boolean' | 'string' | 'message' | 'array' | 'object'

export interface ApiParam {
  name: string
  type: ApiParamType
  required?: boolean
  title: LocalizedText
  /** The documented default, shown when the param is left out. */
  default?: string | number | boolean
  /** The only values the docs allow. */
  options?: string[]
  min?: number
  max?: number
}

export interface ApiInfo {
  action: string
  title: LocalizedText
  /** Where the params come from: the OneBot 11 spec, or NapCat's docs and source. */
  source: 'onebot11' | 'napcat'
  /** What the docs say that a param table cannot, such as "one of these is needed". */
  note?: LocalizedText
  params: ApiParam[]
}

const text = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })

type Extra = Pick<ApiParam, 'required' | 'default' | 'options' | 'min' | 'max'>
const p = (name: string, type: ApiParamType, en: string, zh: string, extra: Extra = {}): ApiParam => ({ name, type, title: text(en, zh), ...extra })
const req = { required: true }

const groupId = p('group_id', 'int', 'Group id', '群号', req)
const userId = p('user_id', 'int', 'QQ number', 'QQ 号', req)
const messageId = p('message_id', 'int', 'Message id', '消息 ID', req)
const message = p('message', 'message', 'Message', '要发送的内容', req)
const autoEscape = p('auto_escape', 'boolean', 'Send as plain text (no CQ codes)', '作为纯文本发送（不解析 CQ 码）', { default: false })
const noCache = p('no_cache', 'boolean', 'Skip the cache', '不使用缓存', { default: false })
const domain = p('domain', 'string', 'Domain', '域名', { default: '' })
const flag01 = (name: string, en: string, zh: string, value: number) => p(name, 'int', en, zh, { default: value, options: ['0', '1'] })

const standard = (action: string, en: string, zh: string, params: ApiParam[] = []): ApiInfo => ({ action, title: text(en, zh), source: 'onebot11', params })
const napcat = (action: string, en: string, zh: string, params: ApiParam[] = [], note?: LocalizedText): ApiInfo => ({ action, title: text(en, zh), source: 'napcat', params, ...(note ? { note } : {}) })

export const onebotApis: ApiInfo[] = [
  // ---- OneBot 11 ----
  standard('send_private_msg', 'Send a private message', '发送私聊消息', [userId, message, autoEscape]),
  standard('send_group_msg', 'Send a group message', '发送群消息', [groupId, message, autoEscape]),
  standard('send_msg', 'Send a message', '发送消息', [
    p('message_type', 'string', 'Message type; without it the *_id given decides', '消息类型；不填则按传入的 *_id 判断', { options: ['private', 'group'] }),
    p('user_id', 'int', 'QQ number (for private)', 'QQ 号（private 时需要）'),
    p('group_id', 'int', 'Group id (for group)', '群号（group 时需要）'),
    message,
    autoEscape,
  ]),
  standard('delete_msg', 'Recall a message', '撤回消息', [messageId]),
  standard('get_msg', 'Get a message', '获取消息', [messageId]),
  standard('get_forward_msg', 'Get a forwarded message', '获取合并转发消息', [p('id', 'string', 'Forward id', '合并转发 ID', req)]),
  standard('send_like', 'Like a profile', '发送好友赞', [userId, p('times', 'int', 'Times, at most 10 a day per friend', '次数，每个好友每天最多 10 次', { default: 1, min: 1, max: 10 })]),
  standard('set_group_kick', 'Kick a member', '群组踢人', [groupId, p('user_id', 'int', 'QQ number to kick', '要踢的 QQ 号', req), p('reject_add_request', 'boolean', 'Reject their join requests', '拒绝此人的加群请求', { default: false })]),
  standard('set_group_ban', 'Mute a member', '群组单人禁言', [groupId, p('user_id', 'int', 'QQ number to mute', '要禁言的 QQ 号', req), p('duration', 'int', 'Seconds; 0 unmutes', '禁言秒数，0 表示取消禁言', { default: 1800, min: 0 })]),
  standard('set_group_anonymous_ban', 'Mute an anonymous member', '群组匿名用户禁言', [
    groupId,
    p('anonymous', 'object', 'The anonymous user (the anonymous field of the message)', '匿名用户对象（群消息上报的 anonymous 字段）'),
    p('anonymous_flag', 'string', 'Or the anonymous user\'s flag', '或匿名用户的 flag'),
    p('duration', 'int', 'Seconds; cannot be undone', '禁言秒数，无法取消', { default: 1800, min: 0 }),
  ]),
  standard('set_group_whole_ban', 'Mute everyone', '群组全员禁言', [groupId, p('enable', 'boolean', 'Mute', '是否禁言', { default: true })]),
  standard('set_group_admin', 'Set an admin', '群组设置管理员', [groupId, p('user_id', 'int', 'QQ number', '要设置管理员的 QQ 号', req), p('enable', 'boolean', 'true sets, false removes', 'true 为设置，false 为取消', { default: true })]),
  standard('set_group_anonymous', 'Allow anonymous chat', '群组匿名', [groupId, p('enable', 'boolean', 'Allow anonymous chat', '是否允许匿名聊天', { default: true })]),
  standard('set_group_card', 'Set a group card', '设置群名片', [groupId, p('user_id', 'int', 'QQ number', '要设置的 QQ 号', req), p('card', 'string', 'Card; empty removes it', '群名片内容，不填或空字符串表示删除', { default: '' })]),
  standard('set_group_name', 'Rename the group', '设置群名', [groupId, p('group_name', 'string', 'New group name', '新群名', req)]),
  standard('set_group_leave', 'Leave the group', '退出群组', [groupId, p('is_dismiss', 'boolean', 'Disband; the owner can only leave this way', '是否解散，群主仅在此项为 true 时能够解散', { default: false })]),
  standard('set_group_special_title', 'Set a special title', '设置群组专属头衔', [
    groupId,
    p('user_id', 'int', 'QQ number', '要设置的 QQ 号', req),
    p('special_title', 'string', 'Title; empty removes it', '专属头衔，不填或空字符串表示删除', { default: '' }),
    p('duration', 'int', 'Seconds; -1 is forever', '有效期秒数，-1 表示永久', { default: -1, min: -1 }),
  ]),
  standard('set_friend_add_request', 'Handle a friend request', '处理加好友请求', [
    p('flag', 'string', 'The request\'s flag', '加好友请求的 flag', req),
    p('approve', 'boolean', 'Approve', '是否同意请求', { default: true }),
    p('remark', 'string', 'Remark, when approving', '好友备注（仅在同意时有效）', { default: '' }),
  ]),
  standard('set_group_add_request', 'Handle a group request', '处理加群请求／邀请', [
    p('flag', 'string', 'The request\'s flag', '加群请求的 flag', req),
    p('sub_type', 'string', 'Must match the request\'s sub_type', '请求类型，需和上报的 sub_type 相符', { ...req, options: ['add', 'invite'] }),
    p('approve', 'boolean', 'Approve', '是否同意请求／邀请', { default: true }),
    p('reason', 'string', 'Reason, when rejecting', '拒绝理由（仅在拒绝时有效）', { default: '' }),
  ]),
  standard('get_login_info', 'Bot account', '获取登录号信息'),
  standard('get_stranger_info', 'User info', '获取陌生人信息', [userId, noCache]),
  standard('get_friend_list', 'Friend list', '获取好友列表'),
  standard('get_group_info', 'Group info', '获取群信息', [groupId, noCache]),
  standard('get_group_list', 'Group list', '获取群列表'),
  standard('get_group_member_info', 'Member info', '获取群成员信息', [groupId, userId, noCache]),
  standard('get_group_member_list', 'Member list', '获取群成员列表', [groupId]),
  standard('get_group_honor_info', 'Group honors', '获取群荣誉信息', [groupId, p('type', 'string', 'Honor type, or all', '群荣誉类型，或 all 获取全部', { ...req, options: ['talkative', 'performer', 'legend', 'strong_newbie', 'emotion', 'all'] })]),
  standard('get_cookies', 'Cookies', '获取 Cookies', [domain]),
  standard('get_csrf_token', 'CSRF token', '获取 CSRF Token'),
  standard('get_credentials', 'Credentials', '获取 QQ 相关接口凭证', [domain]),
  standard('get_record', 'Get a voice message', '获取语音', [
    p('file', 'string', 'The record segment\'s file', '收到的语音文件名（消息段的 file）', req),
    p('out_format', 'string', 'Format to convert to', '要转换到的格式', { ...req, options: ['mp3', 'amr', 'wma', 'm4a', 'spx', 'ogg', 'wav', 'flac'] }),
  ]),
  standard('get_image', 'Get an image', '获取图片', [p('file', 'string', 'The image segment\'s file', '收到的图片文件名（消息段的 file）', req)]),
  standard('can_send_image', 'Can send images', '检查是否可以发送图片'),
  standard('can_send_record', 'Can send voice', '检查是否可以发送语音'),
  standard('get_status', 'Status', '获取运行状态'),
  standard('get_version_info', 'Version', '获取版本信息'),
  standard('set_restart', 'Restart', '重启 OneBot 实现', [p('delay', 'int', 'Delay in ms', '延迟毫秒数', { default: 0, min: 0 })]),
  standard('clean_cache', 'Clean the cache', '清理缓存'),

  // ---- NapCat ----
  napcat('send_poke', 'Poke (NapCat)', '戳一戳（NapCat）', [userId, p('group_id', 'int', 'Group id; without it, pokes privately', '群号；不填则私聊戳一戳')]),
  napcat('group_poke', 'Poke in a group (NapCat)', '群聊戳一戳（NapCat）', [groupId, userId]),
  napcat('friend_poke', 'Poke a friend (NapCat)', '私聊戳一戳（NapCat）', [userId]),
  napcat('set_msg_emoji_like', 'React with an emoji (NapCat)', '表情回应（NapCat）', [messageId, p('emoji_id', 'string', 'Emoji id', '表情 ID', req)]),
  napcat('get_group_msg_history', 'Group message history (NapCat)', '获取群历史消息（NapCat）', [
    groupId,
    p('message_seq', 'string', 'Start from this message; empty is the latest', '起始消息序号；不填从最新开始'),
    p('count', 'int', 'How many', '数量', { default: 20, min: 1 }),
    p('reverse_order', 'boolean', 'Oldest first', '倒序', { default: false }),
  ]),
  napcat('_send_group_notice', 'Post a group notice (NapCat)', '发送群公告（NapCat）', [
    groupId,
    p('content', 'string', 'Content', '公告内容', req),
    p('image', 'string', 'Image path or URL', '图片路径或 URL'),
    flag01('pinned', 'Pinned (0/1)', '是否置顶（0/1）', 0),
    p('type', 'int', 'Type', '类型', { default: 1 }),
    flag01('confirm_required', 'Members must confirm (0/1)', '是否需要确认（0/1）', 1),
    flag01('is_show_edit_card', 'Ask members to set their card (0/1)', '是否显示修改群名片引导（0/1）', 0),
    p('tip_window_type', 'int', 'Popup type', '弹窗类型', { default: 0 }),
  ]),
  napcat('set_group_sign', 'Group check-in (NapCat)', '群打卡（NapCat）', [groupId]),
  napcat('set_essence_msg', 'Set an essence message (NapCat)', '设置精华消息（NapCat）', [messageId]),
  napcat('delete_essence_msg', 'Remove an essence message (NapCat)', '移出精华消息（NapCat）', [
    p('message_id', 'int', 'Message id', '消息 ID'),
    p('msg_seq', 'string', 'Message seq', '消息序号'),
    p('msg_random', 'string', 'Message random', '消息随机数'),
    p('group_id', 'int', 'Group id', '群号'),
  ], text('Give message_id, or all of msg_seq, msg_random and group_id', '需要 message_id，或同时提供 msg_seq、msg_random 和 group_id')),
  napcat('send_group_forward_msg', 'Send a forward to a group (NapCat)', '发送群合并转发（NapCat）', [groupId, p('messages', 'array', 'Message nodes', '消息节点', req)]),
  napcat('send_private_forward_msg', 'Send a forward privately (NapCat)', '发送私聊合并转发（NapCat）', [userId, p('messages', 'array', 'Message nodes', '消息节点', req)]),
  napcat('upload_group_file', 'Upload a group file (NapCat)', '上传群文件（NapCat）', [
    groupId,
    p('file', 'string', 'File path or URL', '文件路径或 URL', req),
    p('name', 'string', 'File name', '文件名', req),
    p('folder', 'string', 'Folder id', '文件夹 ID'),
  ]),
]

const byAction = new Map(onebotApis.map((api) => [api.action, api]))

export const apiInfo = (action: string) => byAction.get(action)

const empty = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && !value.trim())

/** One param's value converted to what the API expects, or why it cannot be. */
function convert(param: ApiParam, value: unknown): { value: unknown } | { error: string } {
  let out: unknown = value
  switch (param.type) {
    case 'int': {
      const textValue = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
      if (!/^-?\d+$/.test(textValue)) return { error: `should be a whole number, not ${JSON.stringify(value)}` }
      const number = Number(textValue)
      if (param.min !== undefined && number < param.min) return { error: `should be at least ${param.min}, not ${textValue}` }
      if (param.max !== undefined && number > param.max) return { error: `should be at most ${param.max}, not ${textValue}` }
      // Ids too large for a JS number stay text, as NapCat accepts both.
      out = Number.isSafeInteger(number) ? number : textValue
      break
    }
    case 'boolean':
      if (value === 'true' || value === 'false') out = value === 'true'
      else if (typeof value !== 'boolean') return { error: `should be true or false, not ${JSON.stringify(value)}` }
      break
    case 'string':
      if (typeof value === 'object') return { error: 'should be text' }
      out = String(value)
      break
    case 'message':
      if (typeof value !== 'string' && !Array.isArray(value)) return { error: 'should be text or a list of message segments' }
      break
    case 'array':
      if (!Array.isArray(value)) return { error: 'should be a list' }
      break
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'should be an object' }
      break
  }
  if (param.options && !param.options.includes(String(out))) return { error: `should be one of ${param.options.join(', ')}, not ${JSON.stringify(value)}` }
  return { value: out }
}

export interface ParamProblem {
  param: string
  /** `is empty`, `is missing` or `should be a whole number, not "abc"`. */
  problem: string
}

/**
 * Checks params against the API's table: required ones present and not empty, each of its type,
 * within its range and among its options. Numeric text becomes a number, as the spec wants.
 * Params the table does not list pass as they are; so does every param of an API it does not know.
 */
export function checkParams(action: string, params: Record<string, unknown>): { params: Record<string, unknown>; problems: ParamProblem[] } {
  const api = apiInfo(action)
  if (!api) return { params, problems: [] }
  const problems: ParamProblem[] = []
  const next = { ...params }
  for (const param of api.params) {
    const value = params[param.name]
    if (empty(value)) {
      if (param.required) problems.push({ param: param.name, problem: param.name in params ? 'is empty' : 'is missing' })
      continue
    }
    const result = convert(param, value)
    if ('error' in result) problems.push({ param: param.name, problem: result.error })
    else next[param.name] = result.value
  }
  return { params: next, problems }
}
