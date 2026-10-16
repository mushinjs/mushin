import { describe, expect, it } from 'vitest'
import { toAnthropicMessages } from '../src'

describe('toAnthropicMessages', () => {
  it('lifts leading system text, replays raw turns and groups tool results in one user message', () => {
    const raw = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', id: 'tu_1', name: 'bots__list', input: {} },
      { type: 'tool_use', id: 'tu_2', name: 'providers__list', input: {} },
    ]
    const { system, messages } = toAnthropicMessages([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'What is set up?' },
      { role: 'assistant', content: '', toolCalls: [], raw: { type: 'anthropic', content: raw } },
      { role: 'tool', toolCallId: 'tu_1', content: '[]' },
      { role: 'tool', toolCallId: 'tu_2', content: 'boom', isError: true },
      { role: 'user', content: 'Thanks' },
    ])
    expect(system).toBe('Be brief.')
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'What is set up?' }] },
      { role: 'assistant', content: raw },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: '[]' },
          { type: 'tool_result', tool_use_id: 'tu_2', content: 'boom', is_error: true },
          { type: 'text', text: 'Thanks' },
        ],
      },
    ])
  })

  it('rebuilds tool_use blocks for turns from another provider', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Checking.', toolCalls: [{ id: 'c1', name: 'bots__list', arguments: '{"a":1}' }] },
    ])
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'c1', name: 'bots__list', input: { a: 1 } }],
    })
  })

  it('turns data URLs into base64 image sources', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: [{ type: 'image', url: 'data:image/png;base64,AAAA' }, { type: 'text', text: 'what is this' }] },
    ])
    expect(messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'what is this' },
    ])
  })
})
