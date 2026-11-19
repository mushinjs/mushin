import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { OpenAIClient } from '../src'

const completion = { id: 'c', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }
const tools = [{ name: 'look', description: 'Look', parameters: { type: 'object' } }]

describe('reasoning effort', () => {
  it('leaves effort out for a model that refuses it with tools, and keeps it without tools', async () => {
    const bodies: any[] = []
    const fetch = async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      if (body.tools && body.reasoning_effort) {
        return new Response(JSON.stringify({ error: { message: 'Function tools with reasoning_effort are not supported for m in /v1/chat/completions.' } }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(completion), { headers: { 'content-type': 'application/json' } })
    }
    const client = new OpenAIClient(new OpenAI({ apiKey: 'k', baseURL: 'https://example.test/v1', fetch: fetch as typeof globalThis.fetch, maxRetries: 0 }))
    const messages = [{ role: 'user' as const, content: 'hi' }]

    expect(await client.chat({ model: 'm', messages, tools, effort: 'high' })).toMatchObject({ text: 'ok', effortIgnored: true })
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['high', undefined])

    expect((await client.chat({ model: 'm', messages, tools, effort: 'high' })).effortIgnored).toBe(true)
    expect(bodies).toHaveLength(3)
    expect(bodies[2].reasoning_effort).toBeUndefined()

    expect((await client.chat({ model: 'm', messages, effort: 'high' })).effortIgnored).toBeUndefined()
    expect(bodies[3].reasoning_effort).toBe('high')
  })
})
