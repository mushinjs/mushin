import type { MessageRecord } from '@mushin/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config'
import { ChatMind, type Decision, type MindDeps } from '../src/mind'
import { record, text } from './helpers'

let log: MessageRecord[]
let sent: { text: string; quote?: string }[]
let decisions: Decision[]
let answers: { planner: string[]; reply: string[] }
let calls: { role: string; content: string }[]

function mind(patch: Partial<Config> = {}, deps: Partial<MindDeps> = {}) {
  return new ChatMind({
    config: { ...Config.parse({}), talkValue: 0.5, ...patch },
    selfId: 'bot',
    name: '小喵',
    history: async (limit) => log.slice(-limit),
    persona: () => ({ prompt: '你是猫娘小喵' }),
    chat: async (role, messages) => {
      calls.push({ role, content: messages.at(-1)!.content })
      return { text: answers[role].shift() ?? '' }
    },
    send: async (value, options) => {
      sent.push({ text: value, quote: options.quote })
      log.push(record({ id: 'bot', name: '小喵' }, [text(value)], { direction: 'out', timestamp: Date.now() }))
    },
    onDecision: (decision) => decisions.push(decision),
    random: () => 0.5,
    ...deps,
  })
}

/** A person says something now: it goes to the log, as the bot would record it, and to the mind. */
function say(target: ChatMind, value: string, patch: Partial<MessageRecord> = {}, user = { id: '1', name: 'A' }) {
  const message = record(user, [text(value)], { timestamp: Date.now(), ...patch })
  log.push(message)
  target.push(message)
  return message
}
const mention = { type: 'at', data: { qq: 'bot' } }

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 6, 12) })
  log = []
  sent = []
  decisions = []
  calls = []
  answers = { planner: [], reply: [] }
})
afterEach(() => vi.useRealTimers())

describe('ChatMind', () => {
  it('waits for the sender to pause, then plans, writes and sends in parts', async () => {
    const chat = mind()
    answers.planner.push('{"action":"reply","target":"#2","intent":"接梗","reason":"在叫我"}')
    answers.reply.push('喵？|找我干嘛')
    say(chat, '那个')
    await vi.advanceTimersByTimeAsync(1000)
    say(chat, '小喵在吗', { segments: [mention, text('在吗')] })
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2600)
    expect(calls.map((call) => call.role)).toEqual(['planner', 'reply'])
    expect(calls[0].content).toContain('新消息：#1、#2（其中有人在找你）')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent.map((item) => item.text)).toEqual(['喵？', '找我干嘛'])
    expect(sent[0].quote).toBeUndefined()
    expect(decisions.at(-1)).toMatchObject({ action: 'reply', sent: ['喵？', '找我干嘛'] })
  })

  it('does not ask a model about small talk it has no interest in', async () => {
    const chat = mind({ talkValue: 0.2 })
    say(chat, '今天好热')
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toHaveLength(0)
    expect(decisions.at(-1)).toMatchObject({ action: 'skipped' })
  })

  it('stays quiet when the planner says so and backs off', async () => {
    const chat = mind({ aliases: ['小喵'], talkValue: 1 })
    answers.planner.push('{"action":"no_reply","reason":"插不上话"}')
    say(chat, '小喵你看他们')
    await vi.advanceTimersByTimeAsync(5000)
    expect(decisions.at(-1)).toMatchObject({ action: 'no_reply' })
    expect(chat.willingness.quietUntil).toBeGreaterThan(Date.now())
    say(chat, '小喵小喵')
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.filter((call) => call.role === 'planner')).toHaveLength(1)
  })

  it('waits when the planner asks, then looks again with what came meanwhile', async () => {
    const chat = mind()
    answers.planner.push('{"action":"wait","seconds":5}', '{"action":"reply","target":"#2"}')
    answers.reply.push('好')
    say(chat, '你', { segments: [mention, text('我跟你说')] })
    await vi.advanceTimersByTimeAsync(3000)
    expect(decisions.at(-1)).toMatchObject({ action: 'wait' })
    await vi.advanceTimersByTimeAsync(1000)
    say(chat, '今晚一起吃饭吧')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls.filter((call) => call.role === 'planner')).toHaveLength(2)
    expect(calls[1].content).toContain('新消息：#1、#2')
    expect(sent.map((item) => item.text)).toEqual(['好'])
  })

  it('quotes the message it answers when other messages came after it', async () => {
    const chat = mind()
    answers.planner.push('{"action":"reply","target":"#1"}')
    answers.reply.push('可以')
    const asked = say(chat, '能借我点钱吗', { segments: [mention, text('能借我点钱吗')] })
    say(chat, '哈哈哈', {}, { id: '2', name: 'B' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(sent[0]).toEqual({ text: '可以', quote: asked.messageId })
  })

  it('answers every private message without a planner, and keeps to the daily limit', async () => {
    const chat = mind({ dailyReplies: 1 })
    answers.reply.push('在的', '不该发')
    const direct = { channel: { type: 'private' as const, id: '1' } }
    say(chat, '在吗', direct)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.map((call) => call.role)).toEqual(['reply'])
    say(chat, '还在吗', direct)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent.map((item) => item.text)).toEqual(['在的'])
    expect(decisions.at(-1)).toMatchObject({ action: 'limited' })
  })

  it('logs a failed model call and keeps going', async () => {
    const chat = mind({}, { chat: async () => { throw new Error('model down') } })
    say(chat, '在吗', { segments: [mention, text('在吗')] })
    await vi.advanceTimersByTimeAsync(5000)
    expect(decisions.at(-1)).toMatchObject({ action: 'failed', error: 'model down' })
    expect(chat.idle).toBe(true)
  })

  it('puts what it remembers into both prompts', async () => {
    const recall = vi.fn(async () => ({ summary: '大家在聊考研', people: [], memories: [] }))
    const chat = mind({}, { recall })
    answers.planner.push('{"action":"reply","target":"#1","reason":"在叫我"}')
    answers.reply.push('加油')
    say(chat, '小喵我考研好难', { segments: [mention, text('考研好难')] })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(recall).toHaveBeenCalledOnce()
    expect(calls.map((call) => call.content.includes('<memory>\n之前聊过的：大家在聊考研'))).toEqual([true, true])
  })

  it('still answers when recalling fails', async () => {
    const chat = mind({}, { recall: async () => { throw new Error('db down') } })
    answers.planner.push('{"action":"reply","target":"#1","reason":"在叫我"}')
    answers.reply.push('在')
    say(chat, '小喵在吗', { segments: [mention, text('在吗')] })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(sent.map((item) => item.text)).toEqual(['在'])
    expect(calls[0].content).not.toContain('<memory>')
  })
})
