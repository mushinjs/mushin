import type { MessageRecord, Segment } from '@mushin/core'

let counter = 0

/** A message record in group 500, a minute after the previous one unless `timestamp` says otherwise. */
export function record(user: { id: string; name?: string; role?: 'owner' | 'admin' | 'member' }, segments: Segment[], patch: Partial<MessageRecord> = {}): MessageRecord {
  counter++
  return {
    id: `r${counter}`,
    botId: 'b',
    messageId: `m${counter}`,
    direction: 'in',
    channel: { type: 'group', id: '500' },
    user,
    segments,
    timestamp: Date.UTC(2026, 10, 6, 12, counter),
    type: 'text',
    platforms: [],
    source: { kind: 'user' },
    ...patch,
  }
}

export const text = (value: string): Segment => ({ type: 'text', data: { text: value } })
