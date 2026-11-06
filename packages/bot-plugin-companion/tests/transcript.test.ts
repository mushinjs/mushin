import { describe, expect, it } from 'vitest'
import { buildTranscript } from '../src/transcript'
import { record, text } from './helpers'

describe('buildTranscript', () => {
  it('numbers messages and says who wrote them, marking the bot and group roles', () => {
    const transcript = buildTranscript([
      record({ id: '1', name: '小明', role: 'owner' }, [text('今晚开黑吗')]),
      record({ id: 'bot', name: '小喵' }, [text('我可以')], { direction: 'out' }),
    ], { selfId: 'bot', selfName: '小喵' })
    const lines = transcript.text.split('\n')
    expect(lines[0]).toMatch(/^\[#1 \d\d:\d\d\] 小明（群主）：今晚开黑吗$/)
    expect(lines[1]).toMatch(/^\[#2 \d\d:\d\d\] 你（小喵）：我可以$/)
    expect(transcript.find('#2')?.self).toBe(true)
    expect(transcript.find('1')?.record.user.name).toBe('小明')
  })

  it('shows mentions, pictures and which message a reply quotes', () => {
    const first = record({ id: '1', name: 'A' }, [text('看这个'), { type: 'image', data: { file: 'x.png' } }])
    const second = record({ id: '2', name: 'B' }, [{ type: 'reply', data: { id: first.messageId } }, { type: 'at', data: { qq: 'bot' } }, text(' 你觉得呢')])
    const transcript = buildTranscript([first, second], { selfId: 'bot' })
    expect(transcript.text).toContain('A：看这个[图片]')
    expect(transcript.text).toContain('B：@你 你觉得呢（回复 #1）')
  })

  it('skips empty messages and cuts long ones', () => {
    const transcript = buildTranscript([
      record({ id: '1' }, [{ type: 'reply', data: { id: 'nope' } }]),
      record({ id: '2' }, [text('啊'.repeat(400))]),
    ], { maxChars: 10 })
    expect(transcript.lines).toHaveLength(1)
    expect(transcript.lines[0].text).toBe(`${'啊'.repeat(10)}…`)
    expect(transcript.text).toContain('[#2 ')
  })

  it('can show user ids, for the memory digest', () => {
    const transcript = buildTranscript([record({ id: '42', name: 'A' }, [text('hi')])], { userIds: true })
    expect(transcript.text).toMatch(/A\[42\]：hi$/)
  })
})
