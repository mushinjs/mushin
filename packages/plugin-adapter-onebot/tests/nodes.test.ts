import { describe, expect, it } from 'vitest'
import { seg } from '@mushin/core'
import { builtinNodes, compile, type FlowBot, type FlowDocument, type FlowEvent, type FlowSession, type NodeType, runFlow } from '@mushin/plugin-flows'
import { onebotNodes } from '../src/nodes'

const types = new Map<string, NodeType>([...builtinNodes, ...onebotNodes].map((type) => [type.type, type]))
const logger = { info() {}, warn() {}, debug() {}, error() {} } as any
const SELF = 10001

function doc(nodes: { id: string; type: string; config?: any; inputs?: any }[], edges: [string, string, string][] = []): FlowDocument {
  return {
    id: 'f1',
    name: 'OneBot test',
    bots: [],
    nodes: nodes.map((node) => ({ ...node, position: { x: 0, y: 0 }, config: node.config ?? {} })),
    edges: edges.map(([source, handle, target], index) => ({ id: `e${index}`, source, sourceHandle: `exec:${handle}`, target, targetHandle: 'exec' })),
    createdAt: 0,
    updatedAt: 0,
  }
}

function session(options: { text?: string; group?: string; user?: string; role?: 'owner' | 'admin' | 'member'; messageId?: string } = {}): FlowSession {
  const user = { id: options.user ?? '42', name: 'Ann', ...(options.role ? { role: options.role } : {}) }
  const text = options.text ?? 'hi'
  return {
    text,
    segments: [seg.text(text)],
    user,
    channel: options.group === '' ? { type: 'private', id: user.id } : { type: 'group', id: options.group ?? '500' },
    isDirect: options.group === '',
    mentioned: false,
    messageId: options.messageId ?? '9001',
    send: async () => ({ messageId: 'm1' }),
    reply: async () => ({ messageId: 'm1' }),
  }
}

function fakeBot(respond: (action: string, params: any) => any = () => ({})) {
  const calls: { action: string; params: any }[] = []
  const sent: { channel: any; content: any }[] = []
  const bot: FlowBot = {
    id: 'b1',
    platform: 'onebot',
    selfId: String(SELF),
    async call(action, params = {}) {
      calls.push({ action, params })
      const value = respond(action, params)
      if (value instanceof Error) throw value
      return value
    },
    async send(channel, content) {
      sent.push({ channel, content })
      return { messageId: 'm2' }
    },
  }
  return { bot, calls, sent }
}

/** Runs one action node after a message trigger; returns the API calls and the node's step. */
async function runNode(node: { type: string; config?: any; inputs?: any }, options: { session?: FlowSession; event?: FlowEvent; respond?: (action: string, params: any) => any } = {}) {
  const { bot, calls, sent } = fakeBot(options.respond)
  const trigger = options.event ? { id: 't', type: 'onebot.event' } : { id: 't', type: 'trigger.message' }
  const compiled = compile(doc([trigger, { id: 'n', ...node }], [['t', 'next', 'n']]), types)
  expect(compiled.issues.filter((issue) => issue.severity === 'error')).toEqual([])
  const result = await runFlow(compiled, { session: options.session ?? session(), vars: { get() {}, set() {} }, logger, bot, event: options.event })
  expect(result.trace.error).toBeUndefined()
  const step = result.trace.steps.find((item) => item.nodeId === 'n')!
  return { calls, sent, step, trace: result.trace }
}

/** Matches one trigger against an event; returns its outputs, or undefined when it did not match. */
async function matchEvent(type: string, config: any, name: string, data: Record<string, any>, message?: FlowEvent['message']) {
  const compiled = compile(doc([{ id: 't', type, config }]), types)
  expect(compiled.issues.filter((issue) => issue.severity === 'error')).toEqual([])
  const event: FlowEvent = { name, data: { time: 1, self_id: SELF, ...data }, ...(message ? { message } : {}) }
  const result = await runFlow(compiled, { session: session({ text: '' }), vars: { get() {}, set() {} }, logger, event })
  return result.matched ? result.trace.steps[0].outputs : undefined
}

describe('OneBot node registry', () => {
  it('has unique types with OneBot or NapCat descriptions', () => {
    const ids = onebotNodes.map((type) => type.type)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('onebot.'))).toBe(true)
    expect(onebotNodes.filter((type) => type.kind === 'trigger').every((type) => type.kind === 'trigger' && type.source === 'event')).toBe(true)
  })

  it('does not run event triggers on messages, nor message triggers on events', async () => {
    const compiled = compile(doc([{ id: 't', type: 'onebot.event' }, { id: 'm', type: 'trigger.message' }]), types)
    const onMessage = await runFlow(compiled, { session: session(), vars: { get() {}, set() {} }, logger })
    expect(onMessage.trace.steps.map((step) => step.nodeId)).toEqual(['m'])
    const onEvent = await runFlow(compiled, { session: session(), vars: { get() {}, set() {} }, logger, event: { name: 'friend_add', data: { user_id: 1 } } })
    expect(onEvent.trace.steps.map((step) => step.nodeId)).toEqual(['t'])
  })
})

describe('event triggers', () => {
  it('member joined: filters by sub_type and skips the bot itself', async () => {
    const data = { post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve', group_id: 500, user_id: 42, operator_id: 7 }
    expect(await matchEvent('onebot.memberJoin', {}, 'group_increase', data)).toEqual({ groupId: '500', userId: '42', operatorId: '7', subType: 'approve', isSelf: false })
    expect(await matchEvent('onebot.memberJoin', { subType: 'invite' }, 'group_increase', data)).toBeUndefined()
    expect(await matchEvent('onebot.memberJoin', {}, 'group_increase', { ...data, user_id: SELF })).toBeUndefined()
    expect(await matchEvent('onebot.memberJoin', { includeSelf: true }, 'group_increase', { ...data, user_id: SELF })).toMatchObject({ isSelf: true })
  })

  it('member left: kick_me and NapCat\'s disband', async () => {
    const data = { post_type: 'notice', notice_type: 'group_decrease', group_id: 500, user_id: SELF, operator_id: 7 }
    expect(await matchEvent('onebot.memberLeave', {}, 'group_decrease', { ...data, sub_type: 'kick_me' })).toMatchObject({ subType: 'kick_me', isSelf: true })
    expect(await matchEvent('onebot.memberLeave', { subType: 'disband' }, 'group_decrease', { ...data, sub_type: 'disband', user_id: 42 })).toMatchObject({ subType: 'disband', isSelf: false })
    expect(await matchEvent('onebot.memberLeave', { subType: 'leave' }, 'group_decrease', { ...data, sub_type: 'kick' })).toBeUndefined()
  })

  it('poke: group and private shapes, only when the bot is poked by default', async () => {
    const group = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 500, user_id: 42, target_id: SELF }
    expect(await matchEvent('onebot.poke', {}, 'notify.poke', group)).toEqual({ groupId: '500', userId: '42', targetId: String(SELF), isPrivate: false, targetIsBot: true })
    expect(await matchEvent('onebot.poke', {}, 'notify.poke', { ...group, target_id: 43 })).toBeUndefined()
    expect(await matchEvent('onebot.poke', { onlyBot: false }, 'notify.poke', { ...group, target_id: 43 })).toMatchObject({ targetIsBot: false })
    // NapCat private poke: user_id is the chat partner, sender_id the poker; the bot poking back is ignored.
    const friend = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 42, sender_id: 42, target_id: SELF }
    expect(await matchEvent('onebot.poke', { where: 'private' }, 'notify.poke', friend)).toMatchObject({ groupId: '', userId: '42', isPrivate: true })
    expect(await matchEvent('onebot.poke', { onlyBot: false }, 'notify.poke', { ...friend, sender_id: SELF, target_id: 42 })).toBeUndefined()
    expect(await matchEvent('onebot.poke', { where: 'group' }, 'notify.poke', friend)).toBeUndefined()
  })

  it('recall: outputs the recalled text and who recalled it', async () => {
    const data = { post_type: 'notice', notice_type: 'group_recall', group_id: 500, user_id: 42, operator_id: 7, message_id: 9001 }
    const message = { id: '9001', text: 'oops', segments: [seg.text('oops')] }
    expect(await matchEvent('onebot.recall', {}, 'group_recall', data, message)).toEqual({
      groupId: '500', userId: '42', operatorId: '7', messageId: '9001', text: 'oops', message: message.segments, byAdmin: true,
    })
    // friend_recall has no operator_id.
    expect(await matchEvent('onebot.recall', {}, 'friend_recall', { post_type: 'notice', notice_type: 'friend_recall', user_id: 42, message_id: 9002 }))
      .toMatchObject({ groupId: '', operatorId: '42', text: '', byAdmin: false })
    expect(await matchEvent('onebot.recall', {}, 'group_recall', { ...data, operator_id: SELF })).toBeUndefined()
  })

  it('mute changed: whole-group mutes have no member', async () => {
    const data = { post_type: 'notice', notice_type: 'group_ban', sub_type: 'ban', group_id: 500, user_id: 42, operator_id: 7, duration: 600 }
    expect(await matchEvent('onebot.groupBan', {}, 'group_ban', data)).toEqual({ groupId: '500', userId: '42', operatorId: '7', subType: 'ban', duration: 600, wholeGroup: false })
    expect(await matchEvent('onebot.groupBan', {}, 'group_ban', { ...data, user_id: 0, duration: -1 })).toMatchObject({ userId: '', wholeGroup: true })
    expect(await matchEvent('onebot.groupBan', { subType: 'lift_ban' }, 'group_ban', data)).toBeUndefined()
  })

  it('admin changed, file uploaded, new friend', async () => {
    expect(await matchEvent('onebot.groupAdmin', { subType: 'unset' }, 'group_admin', { group_id: 500, user_id: 42, sub_type: 'unset' }))
      .toEqual({ groupId: '500', userId: '42', subType: 'unset' })
    expect(await matchEvent('onebot.groupUpload', {}, 'group_upload', { group_id: 500, user_id: 42, file: { id: '/abc', name: 'a.zip', size: 1024, busid: 102 } }))
      .toEqual({ groupId: '500', userId: '42', fileName: 'a.zip', fileSize: 1024, fileId: '/abc', busid: 102 })
    expect(await matchEvent('onebot.friendAdd', {}, 'friend_add', { user_id: 42 })).toEqual({ userId: '42' })
  })

  it('friend and group requests carry the flag', async () => {
    expect(await matchEvent('onebot.friendRequest', {}, 'request.friend', { user_id: 42, comment: 'hi', flag: 'f1' })).toEqual({ userId: '42', comment: 'hi', flag: 'f1' })
    const group = { group_id: 600, user_id: 42, comment: 'let me in', flag: 'f2', sub_type: 'add' }
    expect(await matchEvent('onebot.groupRequest', {}, 'request.group', group)).toEqual({ groupId: '600', userId: '42', comment: 'let me in', flag: 'f2', subType: 'add' })
    expect(await matchEvent('onebot.groupRequest', { subType: 'invite' }, 'request.group', group)).toBeUndefined()
  })

  it('group info changes from NapCat', async () => {
    expect(await matchEvent('onebot.groupChange', {}, 'group_card', { group_id: 500, user_id: 42, card_new: 'New', card_old: 'Old' }))
      .toMatchObject({ kind: 'card', before: 'Old', after: 'New' })
    expect(await matchEvent('onebot.groupChange', {}, 'notify.group_name', { group_id: 500, user_id: 7, name_new: 'Club' }))
      .toMatchObject({ kind: 'name', after: 'Club', userId: '7' })
    expect(await matchEvent('onebot.groupChange', {}, 'notify.title', { group_id: 500, user_id: 42, title: 'Boss' }))
      .toMatchObject({ kind: 'title', after: 'Boss' })
    expect(await matchEvent('onebot.groupChange', {}, 'essence', { group_id: 500, message_id: 9001, sender_id: 42, operator_id: 7, sub_type: 'delete' }))
      .toMatchObject({ kind: 'essence', userId: '42', operatorId: '7', messageId: '9001', added: false })
    expect(await matchEvent('onebot.groupChange', {}, 'group_msg_emoji_like', { group_id: 500, user_id: 42, message_id: 9001, likes: [{ emoji_id: '76', count: 1 }], is_add: true }))
      .toMatchObject({ kind: 'emojiLike', emojiId: '76', added: true })
    expect(await matchEvent('onebot.groupChange', { kind: 'card' }, 'notify.title', { group_id: 500, user_id: 42, title: 'Boss' })).toBeUndefined()
  })

  it('honor and lucky king from the spec', async () => {
    expect(await matchEvent('onebot.honor', {}, 'notify.honor', { group_id: 500, user_id: 42, honor_type: 'talkative' }))
      .toMatchObject({ kind: 'honor', honorType: 'talkative' })
    expect(await matchEvent('onebot.honor', {}, 'notify.lucky_king', { group_id: 500, user_id: 7, target_id: 42 }))
      .toMatchObject({ kind: 'lucky_king', userId: '7', targetId: '42' })
  })

  it('any event filters by name and sub_type and outputs the whole event', async () => {
    const data = { post_type: 'notice', notice_type: 'notify', sub_type: 'profile_like', operator_id: 42, operator_nick: 'Ann', times: 2 }
    const outputs = await matchEvent('onebot.event', { names: ['notify.profile_like'] }, 'notify.profile_like', data)
    expect(outputs).toMatchObject({ name: 'notify.profile_like', subType: 'profile_like', data: { times: 2 } })
    expect(JSON.parse(String(outputs!.json))).toMatchObject({ operator_nick: 'Ann' })
    expect(await matchEvent('onebot.event', { names: ['notify.poke'] }, 'notify.profile_like', data)).toBeUndefined()
    expect(await matchEvent('onebot.event', { subType: 'poke' }, 'notify.profile_like', data)).toBeUndefined()
  })
})

describe('group management', () => {
  it('mutes the sender by default, and the input overrides the seconds', async () => {
    const { calls, step } = await runNode({ type: 'onebot.mute', config: { seconds: 60 } })
    expect(calls).toEqual([{ action: 'set_group_ban', params: { group_id: 500, user_id: 42, duration: 60 } }])
    expect(step.exec).toBe('ok')
    const override = await runNode({ type: 'onebot.mute', config: { userId: '43', groupId: '600' }, inputs: { seconds: '0' } })
    expect(override.calls[0].params).toEqual({ group_id: 600, user_id: 43, duration: 0 })
  })

  it('takes ids from references', async () => {
    const { calls } = await runNode({ type: 'onebot.mute', config: { userId: '{{sys.userId}}', seconds: 5 } }, { session: session({ user: '77' }) })
    expect(calls[0].params.user_id).toBe(77)
  })

  it('continues on "failed" with the error when the API fails', async () => {
    const { step } = await runNode({ type: 'onebot.mute' }, { respond: () => new Error('OneBot set_group_ban failed (retcode 1400): no permission') })
    expect(step.exec).toBe('failed')
    expect(step.outputs?.error).toContain('no permission')
  })

  it('stops with a clear error when there is no group', async () => {
    const { bot } = fakeBot()
    const compiled = compile(doc([{ id: 't', type: 'trigger.message' }, { id: 'n', type: 'onebot.mute' }], [['t', 'next', 'n']]), types)
    const result = await runFlow(compiled, { session: session({ group: '' }), vars: { get() {}, set() {} }, logger, bot })
    expect(result.trace.error).toMatch(/No group/)
  })

  it('whole-group mute', async () => {
    const { calls } = await runNode({ type: 'onebot.muteAll', config: { enable: false } })
    expect(calls).toEqual([{ action: 'set_group_whole_ban', params: { group_id: 500, enable: false } }])
  })

  it('kicks one member with set_group_kick and several with set_group_kick_members', async () => {
    const one = await runNode({ type: 'onebot.kick', config: { rejectAdd: true } })
    expect(one.calls).toEqual([{ action: 'set_group_kick', params: { group_id: 500, user_id: 42, reject_add_request: true } }])
    const many = await runNode({ type: 'onebot.kick', config: { userIds: '43, 44 45' } })
    expect(many.calls).toEqual([{ action: 'set_group_kick_members', params: { group_id: 500, user_id: ['43', '44', '45'], reject_add_request: false } }])
    expect(many.step.outputs?.count).toBe(3)
  })

  it('admin, card, title, group name', async () => {
    expect((await runNode({ type: 'onebot.setAdmin', config: { enable: false } })).calls[0])
      .toEqual({ action: 'set_group_admin', params: { group_id: 500, user_id: 42, enable: false } })
    expect((await runNode({ type: 'onebot.setCard', config: { card: '{{sys.user}} (new)' } })).calls[0])
      .toEqual({ action: 'set_group_card', params: { group_id: 500, user_id: 42, card: 'Ann (new)' } })
    expect((await runNode({ type: 'onebot.setTitle', config: { title: 'Boss' } })).calls[0])
      .toEqual({ action: 'set_group_special_title', params: { group_id: 500, user_id: 42, special_title: 'Boss', duration: -1 } })
    expect((await runNode({ type: 'onebot.setGroupName', config: { name: 'Club' } })).calls[0])
      .toEqual({ action: 'set_group_name', params: { group_id: 500, group_name: 'Club' } })
  })

  it('announcement, essence, check-in, leave', async () => {
    expect((await runNode({ type: 'onebot.groupNotice', config: { content: 'Rules', pinned: true } })).calls[0])
      .toEqual({ action: '_send_group_notice', params: { group_id: 500, content: 'Rules', pinned: 1, confirm_required: 0 } })
    expect((await runNode({ type: 'onebot.essence' })).calls[0]).toEqual({ action: 'set_essence_msg', params: { message_id: 9001 } })
    expect((await runNode({ type: 'onebot.essence', config: { remove: true, messageId: '77' } })).calls[0]).toEqual({ action: 'delete_essence_msg', params: { message_id: 77 } })
    expect((await runNode({ type: 'onebot.groupSign' })).calls[0]).toEqual({ action: 'set_group_sign', params: { group_id: 500 } })
    expect((await runNode({ type: 'onebot.leaveGroup', config: { dismiss: true } })).calls[0]).toEqual({ action: 'set_group_leave', params: { group_id: 500, is_dismiss: true } })
  })
})

describe('messages and interaction', () => {
  it('recalls the current message, or one the bot sent', async () => {
    expect((await runNode({ type: 'onebot.deleteMsg' })).calls[0]).toEqual({ action: 'delete_msg', params: { message_id: 9001 } })
    expect((await runNode({ type: 'onebot.deleteMsg', config: { messageId: '123' } })).calls[0].params).toEqual({ message_id: 123 })
  })

  it('recalls the message an event is about, such as an essence notice', async () => {
    const event = { name: 'essence', data: { group_id: 500, message_id: 555 } }
    const { calls } = await runNode({ type: 'onebot.deleteMsg' }, { event, session: { ...session(), messageId: undefined } })
    expect(calls[0].params).toEqual({ message_id: 555 })
  })

  it('reads a message', async () => {
    const { calls, step } = await runNode({ type: 'onebot.getMsg', config: { messageId: '7' } }, {
      respond: () => ({ time: 100, message_id: 7, user_id: 43, sender: { user_id: 43, nickname: 'Bob', card: '' }, message: [{ type: 'text', data: { text: 'hello' } }, { type: 'face', data: { id: '1' } }] }),
    })
    expect(calls[0]).toEqual({ action: 'get_msg', params: { message_id: 7 } })
    expect(step.outputs).toMatchObject({ text: 'hello', userId: '43', userName: 'Bob', time: 100 })
  })

  it('sends a forward message with node segments NapCat and go-cqhttp both read', async () => {
    const { calls, step } = await runNode({ type: 'onebot.forward', config: { texts: ['one', 'two {{sys.user}}'], name: 'Helper' } }, { respond: () => ({ message_id: 5, res_id: 'abc' }) })
    expect(calls[0].action).toBe('send_group_forward_msg')
    expect(calls[0].params.group_id).toBe(500)
    expect(calls[0].params.messages).toEqual([
      { type: 'node', data: { user_id: SELF, uin: SELF, nickname: 'Helper', name: 'Helper', content: [{ type: 'text', data: { text: 'one' } }] } },
      { type: 'node', data: { user_id: SELF, uin: SELF, nickname: 'Helper', name: 'Helper', content: [{ type: 'text', data: { text: 'two Ann' } }] } },
    ])
    expect(step.outputs).toMatchObject({ messageId: '5', forwardId: 'abc' })
    const priv = await runNode({ type: 'onebot.forward', config: { targetType: 'private', targetId: '42', texts: ['x'] } })
    expect(priv.calls[0]).toMatchObject({ action: 'send_private_forward_msg', params: { user_id: 42 } })
  })

  it('pokes in the group or privately', async () => {
    expect((await runNode({ type: 'onebot.sendPoke' })).calls[0]).toEqual({ action: 'group_poke', params: { group_id: 500, user_id: 42 } })
    expect((await runNode({ type: 'onebot.sendPoke' }, { session: session({ group: '' }) })).calls[0]).toEqual({ action: 'friend_poke', params: { user_id: 42 } })
  })

  it('reacts with an emoji and likes a profile', async () => {
    expect((await runNode({ type: 'onebot.emojiLike', config: { emojiId: '66' } })).calls[0])
      .toEqual({ action: 'set_msg_emoji_like', params: { message_id: 9001, emoji_id: 66, set: true } })
    expect((await runNode({ type: 'onebot.like', config: { times: 5 } })).calls[0]).toEqual({ action: 'send_like', params: { user_id: 42, times: 5 } })
  })

  it('handles friend requests from the event', async () => {
    const event = { name: 'request.friend', data: { post_type: 'request', request_type: 'friend', user_id: 42, comment: 'hi', flag: 'flag-1' } }
    const { calls } = await runNode({ type: 'onebot.handleRequest', config: { remark: 'Ann' } }, { event })
    expect(calls[0]).toEqual({ action: 'set_friend_add_request', params: { flag: 'flag-1', approve: true, remark: 'Ann' } })
  })

  it('handles group requests with the sub_type of the event', async () => {
    const event = { name: 'request.group', data: { post_type: 'request', request_type: 'group', sub_type: 'invite', group_id: 600, user_id: 42, flag: 'flag-2' } }
    const { calls } = await runNode({ type: 'onebot.handleRequest', config: { approve: false, reason: 'no bots' } }, { event })
    expect(calls[0]).toEqual({ action: 'set_group_add_request', params: { flag: 'flag-2', sub_type: 'invite', type: 'invite', approve: false, reason: 'no bots' } })
  })

  it('needs a request to handle', async () => {
    const { bot } = fakeBot()
    const compiled = compile(doc([{ id: 't', type: 'trigger.message' }, { id: 'n', type: 'onebot.handleRequest' }], [['t', 'next', 'n']]), types)
    const result = await runFlow(compiled, { session: session(), vars: { get() {}, set() {} }, logger, bot })
    expect(result.trace.error).toMatch(/No request/)
  })
})

describe('queries', () => {
  it('member info', async () => {
    const { calls, step } = await runNode({ type: 'onebot.memberInfo' }, {
      respond: () => ({ group_id: 500, user_id: 42, nickname: 'Ann', card: '', role: 'admin', title: 'Boss', level: '3', join_time: 10, last_sent_time: 20 }),
    })
    expect(calls[0]).toEqual({ action: 'get_group_member_info', params: { group_id: 500, user_id: 42, no_cache: false } })
    expect(step.outputs).toMatchObject({ name: 'Ann', role: 'admin', title: 'Boss', level: '3', joinTime: 10, lastSentTime: 20 })
  })

  it('user info, with NapCat\'s qqLevel and long_nick', async () => {
    const { calls, step } = await runNode({ type: 'onebot.userInfo', config: { userId: '43' } }, {
      respond: () => ({ user_id: 43, nickname: 'Bob', sex: 'male', age: 20, qqLevel: 30, long_nick: 'hi there' }),
    })
    expect(calls[0]).toEqual({ action: 'get_stranger_info', params: { user_id: 43, no_cache: false } })
    expect(step.outputs).toMatchObject({ nickname: 'Bob', sex: 'male', age: 20, level: 30, signature: 'hi there' })
  })

  it('group info', async () => {
    const { calls, step } = await runNode({ type: 'onebot.groupInfo' }, { respond: () => ({ group_id: 500, group_name: 'Club', member_count: 12, max_member_count: 200 }) })
    expect(calls[0]).toEqual({ action: 'get_group_info', params: { group_id: 500, no_cache: false } })
    expect(step.outputs).toMatchObject({ name: 'Club', memberCount: 12, maxMemberCount: 200 })
  })

  it('sender role: masters, the role in the message, and a lookup when there is none', async () => {
    expect((await runNode({ type: 'onebot.senderRole', config: { masters: ['42'] } })).step.exec).toBe('master')
    expect((await runNode({ type: 'onebot.senderRole' }, { session: session({ role: 'owner' }) })).step.exec).toBe('owner')
    const lookup = await runNode({ type: 'onebot.senderRole' }, { respond: () => ({ role: 'admin' }) })
    expect(lookup.calls[0]).toEqual({ action: 'get_group_member_info', params: { group_id: 500, user_id: 42 } })
    expect(lookup.step.exec).toBe('admin')
    expect((await runNode({ type: 'onebot.senderRole' }, { session: session({ group: '' }) })).step.exec).toBe('member')
  })

  it('calls any API with JSON params and references', async () => {
    const { calls, step } = await runNode({ type: 'onebot.call', config: { action: 'get_group_honor_info', params: '{"group_id": {{sys.groupId}}, "type": "all"}' } }, {
      respond: () => ({ current_talkative: { user_id: 42 } }),
    })
    expect(calls[0]).toEqual({ action: 'get_group_honor_info', params: { group_id: 500, type: 'all' } })
    expect(step.exec).toBe('ok')
    expect(step.outputs?.data).toEqual({ current_talkative: { user_id: 42 } })
  })

  it('rejects params that are not a JSON object', async () => {
    const { bot } = fakeBot()
    const compiled = compile(doc([{ id: 't', type: 'trigger.message' }, { id: 'n', type: 'onebot.call', config: { action: 'x', params: '[1]' } }], [['t', 'next', 'n']]), types)
    const result = await runFlow(compiled, { session: session(), vars: { get() {}, set() {} }, logger, bot })
    expect(result.trace.error).toMatch(/JSON object/)
  })
})

describe('test runs', () => {
  it('records API calls without making them and outputs empty values', async () => {
    const compiled = compile(doc([{ id: 't', type: 'trigger.message' }, { id: 'n', type: 'onebot.memberInfo' }], [['t', 'next', 'n']]), types)
    const result = await runFlow(compiled, { session: session(), vars: { get() {}, set() {} }, logger, test: true })
    expect(result.trace.calls).toEqual([{ action: 'get_group_member_info', params: { group_id: 500, user_id: 42, no_cache: false } }])
    expect(result.trace.steps[1]).toMatchObject({ exec: 'ok', outputs: { name: '', role: '', joinTime: 0 } })
  })

  it('refuses to run on a bot of another platform', async () => {
    const { bot } = fakeBot()
    const compiled = compile(doc([{ id: 't', type: 'trigger.message' }, { id: 'n', type: 'onebot.like' }], [['t', 'next', 'n']]), types)
    const result = await runFlow(compiled, { session: session(), vars: { get() {}, set() {} }, logger, bot: { ...bot, platform: 'demo' } })
    expect(result.trace.error).toMatch(/needs a OneBot bot/)
  })
})
