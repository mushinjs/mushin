import { describe, expect, it } from 'vitest'
import { eventName, idOf, normalizeEvent } from '../src/events'

// Payload shapes follow the OneBot 11 spec and NapCat's event classes (packages/napcat-onebot/event).
const base = { time: 1_700_000_000, self_id: 10001 }

describe('eventName', () => {
  it('names notices, notify sub types and requests', () => {
    expect(eventName({ post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve' })).toBe('group_increase')
    expect(eventName({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke' })).toBe('notify.poke')
    expect(eventName({ post_type: 'notice', notice_type: 'notify', sub_type: 'lucky_king' })).toBe('notify.lucky_king')
    expect(eventName({ post_type: 'request', request_type: 'friend' })).toBe('request.friend')
    expect(eventName({ post_type: 'request', request_type: 'group', sub_type: 'invite' })).toBe('request.group')
    expect(eventName({ post_type: 'meta_event', meta_event_type: 'heartbeat' })).toBeUndefined()
  })
})

describe('idOf', () => {
  it('treats 0 and missing ids as no id', () => {
    expect(idOf(0)).toBeUndefined()
    expect(idOf(undefined)).toBeUndefined()
    expect(idOf(123)).toBe('123')
  })
})

describe('normalizeEvent', () => {
  it('puts group events in the group, about the member', () => {
    const event = normalizeEvent({ ...base, post_type: 'notice', notice_type: 'group_increase', sub_type: 'invite', group_id: 500, user_id: 42, operator_id: 7 })
    expect(event).toMatchObject({ type: 'notice', name: 'group_increase', channel: { type: 'group', id: '500' }, user: { id: '42' } })
  })

  it('takes the poker from sender_id in a private poke (NapCat)', () => {
    const event = normalizeEvent({ ...base, post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 42, sender_id: 42, target_id: 10001, raw_info: [] })
    expect(event).toMatchObject({ name: 'notify.poke', channel: { type: 'private', id: '42' }, user: { id: '42' } })
  })

  it('takes the poker from user_id in a group poke', () => {
    const event = normalizeEvent({ ...base, post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 500, user_id: 42, target_id: 10001 })
    expect(event).toMatchObject({ channel: { type: 'group', id: '500' }, user: { id: '42' } })
  })

  it('answers group invitations privately and join requests in the group', () => {
    const invite = normalizeEvent({ ...base, post_type: 'request', request_type: 'group', sub_type: 'invite', group_id: 600, user_id: 42, comment: '', flag: 'f1' })
    expect(invite.channel).toEqual({ type: 'private', id: '42' })
    const add = normalizeEvent({ ...base, post_type: 'request', request_type: 'group', sub_type: 'add', group_id: 600, user_id: 42, comment: 'hi', flag: 'f2' })
    expect(add.channel).toEqual({ type: 'group', id: '600' })
  })

  it('puts friend requests in a private chat', () => {
    const event = normalizeEvent({ ...base, post_type: 'request', request_type: 'friend', user_id: 42, comment: 'hello', flag: 'f3' })
    expect(event).toMatchObject({ name: 'request.friend', channel: { type: 'private', id: '42' }, user: { id: '42' } })
  })

  it('has no member for a whole-group mute', () => {
    const event = normalizeEvent({ ...base, post_type: 'notice', notice_type: 'group_ban', sub_type: 'ban', group_id: 500, user_id: 0, operator_id: 7, duration: -1 })
    // The operator is who the event is about when nobody else is.
    expect(event).toMatchObject({ channel: { type: 'group', id: '500' }, user: { id: '7' } })
  })

  it('uses the operator for profile likes (NapCat)', () => {
    const event = normalizeEvent({ ...base, post_type: 'notice', notice_type: 'notify', sub_type: 'profile_like', operator_id: 42, operator_nick: 'Ann', times: 3 })
    expect(event).toMatchObject({ name: 'notify.profile_like', channel: { type: 'private', id: '42' }, user: { id: '42', name: 'Ann' } })
  })

  it('keeps unnamed events as they are', () => {
    expect(normalizeEvent({ ...base, post_type: 'notice' })).toEqual({ type: 'notice', data: { ...base, post_type: 'notice' } })
  })
})
