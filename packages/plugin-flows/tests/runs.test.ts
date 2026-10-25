import { describe, expect, it } from 'vitest'
import { seg } from '@mushin/core'
import { builtinNodes, compile, type FlowDocument, type FlowSession, type NodeType, parseCron, runFlow, type TriggerNodeType } from '../src'

const types = new Map<string, NodeType>(builtinNodes.map((type) => [type.type, type]))
const logger = { info() {}, warn() {}, debug() {}, error() {} } as any
const vars = { get() {}, set() {} }

function doc(nodes: { id: string; type: string; config?: any; inputs?: any }[], edges: [string, string, string][] = []): FlowDocument {
  return {
    id: 'f1',
    name: 'Runs',
    bots: [],
    nodes: nodes.map((node) => ({ ...node, position: { x: 0, y: 0 }, config: node.config ?? {} })),
    edges: edges.map(([source, handle, target], index) => ({ id: `e${index}`, source, sourceHandle: `exec:${handle}`, target, targetHandle: 'exec' })),
    createdAt: 0,
    updatedAt: 0,
  }
}

function session(text = 'hi'): FlowSession {
  return {
    text,
    segments: [seg.text(text)],
    user: { id: '42', name: 'Ann' },
    channel: { type: 'group', id: '500' },
    isDirect: false,
    mentioned: false,
    send: async () => ({ messageId: 's1' }),
    reply: async () => ({ messageId: 's1' }),
  }
}

const schedule = types.get('trigger.schedule') as TriggerNodeType
const configOf = (config: Record<string, any>) => schedule.config!.parse(config)
const at = (text: string) => new Date(text)

describe('cron', () => {
  it('parses lists, ranges and steps, with 7 as Sunday', () => {
    const [minute, hour, day, month, weekday] = parseCron('*/15 8-10 1,15 * 1-5,7')!
    expect([...minute]).toEqual([0, 15, 30, 45])
    expect([...hour]).toEqual([8, 9, 10])
    expect([...day]).toEqual([1, 15])
    expect(month.size).toBe(12)
    expect([...weekday].sort()).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('rejects bad expressions', () => {
    expect(parseCron('* * * *')).toBeUndefined()
    expect(parseCron('60 * * * *')).toBeUndefined()
    expect(parseCron('a * * * *')).toBeUndefined()
    expect(schedule.config!.safeParse({ mode: 'cron', cron: '* *' }).success).toBe(false)
  })
})

describe('schedule trigger', () => {
  it('fires daily once in the set minute', () => {
    const config = configOf({ mode: 'daily', time: '08:30' })
    const since = at('2026-10-24T00:00:00').getTime()
    expect(schedule.due!(config, { now: at('2026-10-24T08:29:59'), since })).toBe(false)
    const first = at('2026-10-24T08:30:10')
    expect(schedule.due!(config, { now: first, since })).toBe(true)
    expect(schedule.due!(config, { now: at('2026-10-24T08:30:40'), last: first.getTime(), since })).toBe(false)
    expect(schedule.due!(config, { now: at('2026-10-25T08:30:05'), last: first.getTime(), since })).toBe(true)
  })

  it('fires on an interval counted from when it started being watched', () => {
    const config = configOf({ mode: 'interval', minutes: 10 })
    const since = at('2026-10-24T08:00:00').getTime()
    expect(schedule.due!(config, { now: at('2026-10-24T08:09:59'), since })).toBe(false)
    expect(schedule.due!(config, { now: at('2026-10-24T08:10:00'), since })).toBe(true)
    expect(schedule.due!(config, { now: at('2026-10-24T08:15:00'), last: at('2026-10-24T08:10:00').getTime(), since })).toBe(false)
  })

  it('fires on cron, with either day field matching when both are set', () => {
    const config = configOf({ mode: 'cron', cron: '0 9 13 * 5' })
    const since = 0
    expect(schedule.due!(config, { now: at('2026-10-23T09:00:00'), since })).toBe(true) // a Friday
    expect(schedule.due!(config, { now: at('2026-10-13T09:00:00'), since })).toBe(true) // the 13th
    expect(schedule.due!(config, { now: at('2026-10-14T09:00:00'), since })).toBe(false)
  })

  it('runs only the scheduled trigger and outputs the time', async () => {
    const compiled = compile(doc([
      { id: 's1', type: 'trigger.schedule', config: { targetId: '500' } },
      { id: 's2', type: 'trigger.schedule', config: { targetId: '500' } },
      { id: 'm', type: 'trigger.message' },
    ]), types)
    const result = await runFlow(compiled, { session: session(''), vars, logger, scheduled: { nodeId: 's2', now: at('2026-10-24T08:05:00') } })
    expect(result.trace.steps).toMatchObject([{ nodeId: 's2', outputs: { time: '08:05', date: '2026-10-24', weekday: 6 } }])
    expect(result.trace.text).toBe('[schedule]')
  })
})

describe('wait for reply', () => {
  const quiz = () => compile(doc([
    { id: 't', type: 'trigger.message' },
    { id: 'w', type: 'logic.waitReply', config: { seconds: 120, who: 'anyone' } },
    { id: 'yes', type: 'action.reply', inputs: { text: 'got {{w.text}} from {{w.userName}}' } },
    { id: 'no', type: 'action.reply', config: { text: 'too late' } },
  ], [['t', 'next', 'w'], ['w', 'reply', 'yes'], ['w', 'timeout', 'no']]), types)

  it('continues on "reply" with the answer', async () => {
    let asked: any
    const result = await runFlow(quiz(), {
      session: session(),
      vars,
      logger,
      waitForMessage: async (options, origin) => {
        asked = options
        return { ...origin, text: '4', segments: [seg.text('4')], user: { id: '43', name: 'Bob' }, messageId: 'r1' }
      },
    })
    expect(asked).toEqual({ who: 'anyone', seconds: 120 })
    expect(result.trace.replies).toEqual(['got 4 from Bob'])
    expect(result.trace.steps[1]).toMatchObject({ exec: 'reply', outputs: { text: '4', userId: '43', messageId: 'r1' } })
  })

  it('continues on "timeout" without an answer, and when nothing can deliver one', async () => {
    const timedOut = await runFlow(quiz(), { session: session(), vars, logger, waitForMessage: async () => undefined })
    expect(timedOut.trace.replies).toEqual(['too late'])
    const none = await runFlow(quiz(), { session: session(), vars, logger })
    expect(none.trace.replies).toEqual(['too late'])
  })

  it('does not count waiting toward the run limit', async () => {
    const waited = await runFlow(quiz(), {
      session: session(),
      vars,
      logger,
      limit: 40,
      waitForMessage: () => new Promise((resolve) => setTimeout(() => resolve(undefined), 120)),
    })
    expect(waited.trace.error).toBeUndefined()
    expect(waited.trace.replies).toEqual(['too late'])

    // Working past the limit still stops the run.
    const slow = compile(doc([
      { id: 't', type: 'trigger.message' },
      { id: 'd', type: 'logic.delay', config: { seconds: 0.12 } },
      { id: 'r', type: 'action.reply', config: { text: 'done' } },
    ], [['t', 'next', 'd'], ['d', 'next', 'r']]), types)
    const stopped = await runFlow(slow, { session: session(), vars, logger, limit: 40 })
    expect(stopped.trace.error).toBeDefined()
    expect(stopped.trace.replies).toEqual([])
  })
})

describe('send to chat', () => {
  it('sends to the current chat, or through the bot to another one', async () => {
    const sent: any[] = []
    const bot = {
      id: 'b1', platform: 'onebot', call: async () => null,
      send: async (channel: any, content: any) => {
        sent.push({ channel, text: content.text })
        return { messageId: 'x9' }
      },
    }
    const compiled = compile(doc([
      { id: 't', type: 'trigger.message' },
      { id: 'here', type: 'action.send', config: { text: 'here' } },
      { id: 'there', type: 'action.send', config: { targetType: 'private', targetId: '{{sys.userId}}', text: 'there' } },
    ], [['t', 'next', 'here'], ['here', 'next', 'there']]), types)
    const result = await runFlow(compiled, { session: session(), vars, logger, bot })
    expect(result.trace.replies).toEqual(['here', '→ private:42: there'])
    expect(sent).toEqual([{ channel: { type: 'private', id: '42' }, text: 'there' }])
    expect(result.trace.steps[1].outputs).toEqual({ messageId: 's1' })
    expect(result.trace.steps[2].outputs).toEqual({ messageId: 'x9' })
  })

  it('continues on "failed" when sending fails', async () => {
    const bot = { id: 'b1', platform: 'onebot', call: async () => null, send: async () => { throw new Error('blocked') } }
    const compiled = compile(doc([
      { id: 't', type: 'trigger.message' },
      { id: 'n', type: 'action.send', config: { targetType: 'group', targetId: '600', text: 'x' } },
    ], [['t', 'next', 'n']]), types)
    const result = await runFlow(compiled, { session: session(), vars, logger, bot })
    expect(result.trace.steps[1].exec).toBe('failed')
  })
})
