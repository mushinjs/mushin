import { describe, expect, it } from 'vitest'
import { cleanReply, reactionDelay, splitReply, typingDelay } from '../src/express'
import { parsePlan } from '../src/planner'
import { replierPrompt, replierSystem } from '../src/replier'
import { buildTranscript } from '../src/transcript'
import { record, text } from './helpers'

describe('replier prompts', () => {
  it('uses the persona and its examples, or a plain group member', () => {
    const system = replierSystem({ name: '小喵', persona: { prompt: '你是猫娘小喵', examples: [{ user: '早', assistant: '早喵' }] }, maxParts: 3, isPrivate: false })
    expect(system).toContain('你是猫娘小喵')
    expect(system).toContain('对方：早\n你：早喵')
    expect(system).toContain('最多 3 条')
    expect(replierSystem({ name: 'x', maxParts: 2, isPrivate: true })).toContain('私聊')
  })

  it('names the message to answer and the planner\'s intent', () => {
    const transcript = buildTranscript([record({ id: '1', name: 'A' }, [text('请客吗')])])
    const plan = parsePlan('{"action":"reply","target":"#1","intent":"装穷"}', { transcript, fresh: ['#1'], addressed: true, name: '小喵', isPrivate: false })
    const prompt = replierPrompt({ transcript, plan, name: '小喵', maxParts: 3, isPrivate: false })
    expect(prompt).toContain('你要回复 #1（A：请客吗）。')
    expect(prompt).toContain('你的想法：装穷')
  })
})

describe('cleanReply', () => {
  it('drops speaker labels, Markdown and assistant phrases', () => {
    expect(cleanReply('小喵：才不请', '小喵')).toBe('才不请')
    expect(cleanReply('[#4 12:00] 你（小喵）：不请')).toBe('不请')
    expect(cleanReply('**真的**吗')).toBe('真的吗')
    expect(cleanReply('作为一个AI，我觉得还行')).toBe('我觉得还行')
    expect(cleanReply('“哈哈”')).toBe('哈哈')
  })
})

describe('splitReply', () => {
  it('splits at bars, then at lines or sentences, and drops a closing full stop', () => {
    expect(splitReply('不请|你请我还差不多。', 3)).toEqual(['不请', '你请我还差不多'])
    expect(splitReply('哈哈\n笑死', 3)).toEqual(['哈哈', '笑死'])
    expect(splitReply('真的吗？我不信。', 3)).toEqual(['真的吗？', '我不信'])
  })

  it('keeps at most maxParts and leaves a long answer whole', () => {
    expect(splitReply('a|b|c|d', 2)).toEqual(['a', 'b c d'])
    const long = `${'这是一句很长的解释。'.repeat(15)}`
    expect(splitReply(long, 3)).toHaveLength(1)
  })
})

describe('delays', () => {
  it('types at the given speed within bounds', () => {
    expect(typingDelay('一二三四五六七八', 8, () => 0.5)).toBe(1000)
    expect(typingDelay('a', 8, () => 0)).toBe(600)
    expect(typingDelay('字'.repeat(500), 8, () => 1)).toBe(8000)
    expect(reactionDelay(() => 0)).toBe(1000)
    expect(reactionDelay(() => 1)).toBe(3000)
  })
})
