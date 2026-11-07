import type { LocalizedText } from '@mushin/core'

/**
 * The params of common OneBot 11 APIs and NapCat's extensions, for the "Call OneBot API" node:
 * the node checks params against it before calling, and the editor offers the names and params.
 * APIs not listed here are called as written.
 */

/** `id` is a QQ, group or message id: a number, though numeric text is accepted and converted. */
export type ApiParamType = 'id' | 'number' | 'boolean' | 'string' | 'message' | 'array' | 'object'

export interface ApiParam {
  name: string
  type: ApiParamType
  required?: boolean
  title: LocalizedText
}

export interface ApiInfo {
  action: string
  title: LocalizedText
  params: ApiParam[]
}

const text = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })
const p = (name: string, type: ApiParamType, en: string, zh: string, required = false): ApiParam => ({ name, type, title: text(en, zh), ...(required ? { required } : {}) })

const groupId = p('group_id', 'id', 'Group id', '群号', true)
const userId = p('user_id', 'id', 'QQ number', 'QQ 号', true)
const messageId = p('message_id', 'id', 'Message id', '消息 ID', true)
const noCache = p('no_cache', 'boolean', 'Skip the cache', '不使用缓存')
const enable = p('enable', 'boolean', 'Turn on', '开启')

export const onebotApis: ApiInfo[] = [
  // Messages
  { action: 'send_private_msg', title: text('Send a private message', '发送私聊消息'), params: [userId, p('message', 'message', 'Message', '消息内容', true), p('auto_escape', 'boolean', 'Send CQ codes as text', '不解析 CQ 码')] },
  { action: 'send_group_msg', title: text('Send a group message', '发送群消息'), params: [groupId, p('message', 'message', 'Message', '消息内容', true), p('auto_escape', 'boolean', 'Send CQ codes as text', '不解析 CQ 码')] },
  {
    action: 'send_msg',
    title: text('Send a message', '发送消息'),
    params: [p('message_type', 'string', 'private or group', 'private 或 group'), p('user_id', 'id', 'QQ number', 'QQ 号'), p('group_id', 'id', 'Group id', '群号'), p('message', 'message', 'Message', '消息内容', true)],
  },
  { action: 'delete_msg', title: text('Recall a message', '撤回消息'), params: [messageId] },
  { action: 'get_msg', title: text('Get a message', '获取消息'), params: [messageId] },
  { action: 'get_forward_msg', title: text('Get a forwarded message', '获取合并转发消息'), params: [p('id', 'string', 'Forward id', '合并转发 ID', true)] },
  { action: 'send_group_forward_msg', title: text('Send a forward to a group', '发送群合并转发'), params: [groupId, p('messages', 'array', 'Message nodes', '消息节点', true)] },
  { action: 'send_private_forward_msg', title: text('Send a forward privately', '发送私聊合并转发'), params: [userId, p('messages', 'array', 'Message nodes', '消息节点', true)] },
  { action: 'get_group_msg_history', title: text('Group message history', '群历史消息'), params: [groupId, p('message_seq', 'id', 'Start from message', '起始消息序号'), p('count', 'number', 'How many', '数量')] },
  { action: 'set_msg_emoji_like', title: text('React with an emoji', '表情回应'), params: [messageId, p('emoji_id', 'string', 'Emoji id', '表情 ID', true)] },
  { action: 'set_essence_msg', title: text('Set an essence message', '设为精华消息'), params: [messageId] },
  { action: 'delete_essence_msg', title: text('Remove an essence message', '移出精华消息'), params: [messageId] },
  // Pokes and likes
  { action: 'send_like', title: text('Like a profile', '点赞名片'), params: [userId, p('times', 'number', 'Times', '次数')] },
  { action: 'group_poke', title: text('Poke in a group', '群里戳一戳'), params: [groupId, userId] },
  { action: 'friend_poke', title: text('Poke a friend', '私聊戳一戳'), params: [userId] },
  { action: 'send_poke', title: text('Poke', '戳一戳'), params: [userId, p('group_id', 'id', 'Group id; empty pokes privately', '群号；留空为私聊戳'), p('target_id', 'id', 'Target', '目标')] },
  // Group management
  { action: 'set_group_kick', title: text('Kick a member', '踢出群成员'), params: [groupId, userId, p('reject_add_request', 'boolean', 'Block rejoining', '拒绝再次加群')] },
  { action: 'set_group_ban', title: text('Mute a member', '禁言群成员'), params: [groupId, userId, p('duration', 'number', 'Seconds; 0 unmutes', '秒数；0 为解除')] },
  { action: 'set_group_whole_ban', title: text('Mute everyone', '全员禁言'), params: [groupId, enable] },
  { action: 'set_group_admin', title: text('Set an admin', '设置管理员'), params: [groupId, userId, enable] },
  { action: 'set_group_card', title: text('Set a group card', '设置群名片'), params: [groupId, userId, p('card', 'string', 'Card; empty clears it', '群名片；留空为清除')] },
  { action: 'set_group_name', title: text('Rename the group', '设置群名'), params: [groupId, p('group_name', 'string', 'Group name', '群名', true)] },
  { action: 'set_group_leave', title: text('Leave the group', '退出群'), params: [groupId, p('is_dismiss', 'boolean', 'Disband (as owner)', '解散（群主）')] },
  { action: 'set_group_special_title', title: text('Set a special title', '设置专属头衔'), params: [groupId, userId, p('special_title', 'string', 'Title', '头衔'), p('duration', 'number', 'Seconds', '秒数')] },
  { action: '_send_group_notice', title: text('Post a group notice', '发布群公告'), params: [groupId, p('content', 'string', 'Content', '内容', true), p('image', 'string', 'Image', '图片')] },
  { action: 'set_group_sign', title: text('Group check-in', '群打卡'), params: [groupId] },
  { action: 'upload_group_file', title: text('Upload a group file', '上传群文件'), params: [groupId, p('file', 'string', 'Local file path', '本地文件路径', true), p('name', 'string', 'File name', '文件名', true), p('folder', 'string', 'Folder id', '文件夹 ID')] },
  // Requests
  {
    action: 'set_friend_add_request',
    title: text('Handle a friend request', '处理加好友请求'),
    params: [p('flag', 'string', 'Request flag', '请求 flag', true), p('approve', 'boolean', 'Approve', '同意'), p('remark', 'string', 'Remark', '备注')],
  },
  {
    action: 'set_group_add_request',
    title: text('Handle a group request', '处理加群请求'),
    params: [p('flag', 'string', 'Request flag', '请求 flag', true), p('sub_type', 'string', 'add or invite', 'add 或 invite', true), p('approve', 'boolean', 'Approve', '同意'), p('reason', 'string', 'Reason when rejecting', '拒绝理由')],
  },
  // Information
  { action: 'get_login_info', title: text('Bot account', '登录号信息'), params: [] },
  { action: 'get_stranger_info', title: text('User info', '陌生人信息'), params: [userId, noCache] },
  { action: 'get_friend_list', title: text('Friend list', '好友列表'), params: [] },
  { action: 'get_group_info', title: text('Group info', '群信息'), params: [groupId, noCache] },
  { action: 'get_group_list', title: text('Group list', '群列表'), params: [] },
  { action: 'get_group_member_info', title: text('Member info', '群成员信息'), params: [groupId, userId, noCache] },
  { action: 'get_group_member_list', title: text('Member list', '群成员列表'), params: [groupId] },
  { action: 'get_group_honor_info', title: text('Group honors', '群荣誉'), params: [groupId, p('type', 'string', 'talkative, performer, legend, strong_newbie, emotion or all', 'talkative、performer、legend、strong_newbie、emotion 或 all', true)] },
  { action: 'get_image', title: text('Get an image', '获取图片'), params: [p('file', 'string', 'File', '文件', true)] },
  { action: 'get_record', title: text('Get a voice message', '获取语音'), params: [p('file', 'string', 'File', '文件', true), p('out_format', 'string', 'Format, e.g. mp3', '格式，如 mp3', true)] },
  { action: 'can_send_image', title: text('Can send images', '能否发图片'), params: [] },
  { action: 'can_send_record', title: text('Can send voice', '能否发语音'), params: [] },
  { action: 'get_status', title: text('Status', '运行状态'), params: [] },
  { action: 'get_version_info', title: text('Version', '版本信息'), params: [] },
]

const byAction = new Map(onebotApis.map((api) => [api.action, api]))

export const apiInfo = (action: string) => byAction.get(action)

const empty = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && !value.trim())

/** One param's value converted to what the API expects, or why it cannot be. */
function convert(param: ApiParam, value: unknown): { value: unknown } | { error: string } {
  switch (param.type) {
    case 'id':
    case 'number': {
      if (typeof value === 'number' && Number.isFinite(value)) return { value }
      const textValue = typeof value === 'string' ? value.trim() : ''
      if (textValue && Number.isFinite(Number(textValue))) {
        // Ids too large for a JS number stay text, as NapCat accepts both.
        return { value: param.type === 'id' && !Number.isSafeInteger(Number(textValue)) ? textValue : Number(textValue) }
      }
      return { error: `should be a number, not ${JSON.stringify(value)}` }
    }
    case 'boolean':
      if (typeof value === 'boolean') return { value }
      if (value === 'true' || value === 'false') return { value: value === 'true' }
      return { error: `should be true or false, not ${JSON.stringify(value)}` }
    case 'string':
      return typeof value === 'object' ? { error: 'should be text' } : { value: String(value) }
    case 'message':
      return typeof value === 'string' || Array.isArray(value) ? { value } : { error: 'should be text or a list of message segments' }
    case 'array':
      return Array.isArray(value) ? { value } : { error: 'should be a list' }
    case 'object':
      return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { error: 'should be an object' }
  }
}

export interface ParamProblem {
  param: string
  /** `is empty`, `is missing` or `should be a number, not "abc"`. */
  problem: string
}

/**
 * Checks params against the API's table: required ones present and not empty, each of the right
 * type. Numeric text becomes a number, as the spec wants. Params the table does not list pass as
 * they are; so does every param of an API it does not know.
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
