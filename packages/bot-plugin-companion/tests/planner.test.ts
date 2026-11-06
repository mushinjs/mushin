import { describe, expect, it } from 'vitest'
import { parsePlan, plannerPrompt, plannerSystem, type PlanRequest } from '../src/planner'
import { buildTranscript } from '../src/transcript'
import { record, text } from './helpers'

const transcript = buildTranscript([
  record({ id: '1', name: 'A' }, [text('今晚吃啥')]),
  record({ id: 'bot', name: '小喵' }, [text('火锅！')], { direction: 'out' }),
  record({ id: '2', name: 'B' }, [text('小喵你请客吗')]),
], { selfId: 'bot', selfName: '小喵' })
const request: PlanRequest = { transcript, fresh: ['#3'], addressed: true, name: '小喵', isPrivate: false }

describe('planner prompts', () => {
  it('puts the persona in the system prompt and the chat in the message', () => {
    expect(plannerSystem({ name: '小喵', persona: '一只爱吃的猫' })).toContain('一只爱吃的猫')
    const prompt = plannerPrompt(request)
    expect(prompt).toContain('<chat>\n[#1')
    expect(prompt).toContain('新消息：#3（其中有人在找你）')
  })
})

describe('parsePlan', () => {
  it('reads a reply with its target and intent, even inside a code fence', () => {
    const plan = parsePlan('```json\n{"action":"reply","target":"#3","intent":"装穷","reason":"在问我"}\n```', request)
    expect(plan).toEqual({ action: 'reply', target: '#3', intent: '装穷', reason: '在问我' })
  })

  it('reads the mood the planner names', () => {
    expect(parsePlan('{"action":"no_reply","mood":"无聊","reason":"没意思"}', request)).toEqual({ action: 'no_reply', mood: '无聊', reason: '没意思' })
    expect(plannerPrompt({ ...request, mood: '开心', memory: '<memory>\n之前聊过的：吃饭\n</memory>' })).toMatch(/^<memory>[\s\S]*你现在的心情：开心/)
  })

  it('never targets the bot\'s own message and keeps waits between 3 and 20 seconds', () => {
    expect(parsePlan('{"action":"reply","target":"#2"}', request).target).toBe('#3')
    expect(parsePlan('{"action":"wait","seconds":99}', request)).toMatchObject({ action: 'wait', seconds: 20 })
    expect(parsePlan('{"action":"wait"}', request)).toMatchObject({ action: 'wait', seconds: 5 })
  })

  it('falls back to replying when addressed and to silence otherwise', () => {
    expect(parsePlan('我觉得应该回', request)).toMatchObject({ action: 'reply', target: '#3', fallback: true })
    expect(parsePlan('{"action":"dance"}', { ...request, addressed: false })).toMatchObject({ action: 'no_reply', fallback: true })
  })
})
