import { describe, expect, it } from 'vitest'
import { OpenAIClient, ProviderConfig } from '../src'
import { RESPONSES_RAW } from '../src/responses'

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

const output = [
  { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'secret-thoughts' },
  { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bots__list', arguments: '{}', status: 'completed' },
]

describe('Responses API', () => {
  it('is used for api.openai.com, or when chosen, and not for compatible services', () => {
    const uses = (config: Record<string, unknown>) => (OpenAIClient.fromConfig(ProviderConfig.parse({ apiKey: 'k', ...config })) as any).options.responses
    expect(uses({})).toBe(true)
    expect(uses({ baseURL: 'https://api.deepseek.com/v1' })).toBe(false)
    expect(uses({ baseURL: 'https://relay.example/v1', api: 'responses' })).toBe(true)
    expect(uses({ api: 'chat' })).toBe(false)
  })

  it('sends tools with a reasoning effort and replays the reasoning on the next request', async () => {
    const bodies: any[] = []
    const urls: string[] = []
    const fetch = async (url: unknown, init?: RequestInit) => {
      urls.push(String(url))
      bodies.push(JSON.parse(String(init?.body)))
      return bodies.length === 1
        ? json({ id: 'r1', object: 'response', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } })
        : json({ id: 'r2', object: 'response', status: 'completed', output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Two bots.', annotations: [] }] }] })
    }
    const client = OpenAIClient.fromConfig(ProviderConfig.parse({ apiKey: 'k' }))
    ;(client as any).sdk = new (await import('openai')).default({ apiKey: 'k', fetch: fetch as typeof globalThis.fetch, maxRetries: 0 })
    const tools = [{ name: 'bots__list', description: 'List bots', parameters: { type: 'object' } }]
    const messages = [{ role: 'system' as const, content: 'Be brief.' }, { role: 'user' as const, content: 'Which bots?' }]

    const first = await client.chat({ model: 'gpt-x', messages, tools, effort: 'max', maxTokens: 100 })
    expect(urls[0]).toMatch(/\/responses$/)
    expect(bodies[0]).toMatchObject({
      model: 'gpt-x',
      instructions: 'Be brief.',
      input: [{ role: 'user', content: 'Which bots?' }],
      reasoning: { effort: 'xhigh' },
      max_output_tokens: 100,
      store: false,
      include: ['reasoning.encrypted_content'],
      tools: [{ type: 'function', name: 'bots__list' }],
    })
    expect(first).toMatchObject({ toolCalls: [{ id: 'call_1', name: 'bots__list', arguments: '{}' }], finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 }, raw: { type: RESPONSES_RAW } })

    const second = await client.chat({
      model: 'gpt-x',
      tools,
      messages: [...messages, { role: 'assistant', content: '', toolCalls: first.toolCalls, raw: first.raw }, { role: 'tool', toolCallId: 'call_1', content: '[2 bots]' }],
    })
    expect(bodies[1].input.slice(1)).toEqual([...output, { type: 'function_call_output', call_id: 'call_1', output: '[2 bots]' }])
    expect(second).toMatchObject({ text: 'Two bots.', finishReason: 'stop' })
  })

  it('streams text deltas and the final response', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'Hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      { type: 'response.completed', response: { id: 'r', object: 'response', status: 'completed', output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] }] } },
    ]
    const fetch = async () => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    const client = OpenAIClient.fromConfig(ProviderConfig.parse({ apiKey: 'k' }))
    ;(client as any).sdk = new (await import('openai')).default({ apiKey: 'k', fetch: fetch as typeof globalThis.fetch, maxRetries: 0 })
    const seen: any[] = []
    for await (const event of client.stream!({ model: 'gpt-x', messages: [{ role: 'user', content: 'Hi' }] })) seen.push(event)
    expect(seen.map((event) => event.type === 'delta' ? event.text : event.response.text)).toEqual(['Hel', 'lo', 'Hello'])
  })
})
