import type { ChannelInfo, UserInfo } from '@mushin/core'
import type { BotEvent } from '@mushin/plugin-bots'

/** A OneBot id as Mushin stores it; 0 and missing ids (such as `user_id` of a whole-group mute) become undefined. */
export function idOf(value: unknown) {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') return undefined
  return String(value)
}

/**
 * The name flows match an event by: `notice_type` (`group_increase`, `group_recall`…), `notify.<sub_type>`
 * for the `notify` family (`notify.poke`, `notify.lucky_king`…), `request.<request_type>` for requests.
 */
export function eventName(payload: any): string | undefined {
  if (payload.post_type === 'notice') {
    if (!payload.notice_type) return
    return payload.notice_type === 'notify' ? `notify.${payload.sub_type ?? ''}` : String(payload.notice_type)
  }
  if (payload.post_type === 'request' && payload.request_type) return `request.${payload.request_type}`
}

/** Who an event is about: the person who pokes, joins, is muted, asks to add the bot… */
function actorOf(payload: any, name: string) {
  // A private poke reports the chat partner as user_id and the poker as sender_id (NapCat).
  if (name === 'notify.poke') return idOf(payload.sender_id) ?? idOf(payload.user_id)
  if (name === 'notify.profile_like') return idOf(payload.operator_id)
  return idOf(payload.user_id) ?? idOf(payload.operator_id)
}

/**
 * Turns a OneBot notice or request into a `BotEvent` with a name, the chat it happened in and who
 * it is about. A group event happens in the group; anything else in a private chat with the person.
 * A group invitation is answered privately: the bot is not in that group yet.
 */
export function normalizeEvent(payload: any): BotEvent {
  const event: BotEvent = { type: String(payload.post_type), data: payload }
  const name = eventName(payload)
  if (!name) return event
  event.name = name
  const userId = actorOf(payload, name)
  const groupId = idOf(payload.group_id)
  const invited = name === 'request.group' && payload.sub_type === 'invite'
  let channel: ChannelInfo | undefined
  if (groupId && !invited) channel = { type: 'group', id: groupId, ...(payload.group_name ? { name: String(payload.group_name) } : {}) }
  else if (userId) channel = { type: 'private', id: userId }
  if (channel) event.channel = channel
  if (userId) {
    const user: UserInfo = { id: userId }
    const nick = payload.operator_nick ?? payload.nickname
    if (nick) user.name = String(nick)
    event.user = user
  }
  return event
}
