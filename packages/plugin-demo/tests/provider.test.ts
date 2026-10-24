import { describe, expect, it } from 'vitest'
import { DemoClient, demoReply } from '../src/provider'

describe('demo provider', () => {
  it('quotes the last user message in its language', () => {
    expect(demoReply([{ role: 'user', content: 'hi' }])).toContain('You said "hi"')
    expect(demoReply([{ role: 'system', content: '简短' }, { role: 'user', content: '你好' }])).toContain('你说的是「你好」')
  })

  it('answers classification prompts with a label found in the text', () => {
    const system = 'Classify the user\'s message into exactly one of these labels: refund, shipping. If none fits, answer "other". Answer with the label only.'
    expect(demoReply([{ role: 'system', content: system }, { role: 'user', content: 'I want a Refund' }])).toBe('refund')
    expect(demoReply([{ role: 'system', content: system }, { role: 'user', content: 'thanks' }])).toBe('other')
  })

  it('passes the connection test and streams the same text', async () => {
    const client = new DemoClient({ latency: 0 })
    expect((await client.chat({ model: 'demo-chat', messages: [{ role: 'user', content: 'Reply with OK.' }] })).text).toBe('OK')
    let streamed = ''
    for await (const event of client.stream({ model: 'demo-chat', messages: [{ role: 'user', content: 'stream me' }] })) {
      if (event.type === 'delta') streamed += event.text
      else expect(event.response.text).toBe(streamed)
    }
    expect(streamed).toContain('stream me')
  })
})
