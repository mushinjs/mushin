import { describe, expect, it, vi } from 'vitest'
import { fromResponse, GeminiClient, mergeParts, ProviderConfig, toGeminiRequest } from '../src'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function sse(chunks: unknown[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function client(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(fetcher)
  return { mock, client: new GeminiClient(ProviderConfig.parse({ apiKey: 'key' }), mock as unknown as typeof fetch) }
}

describe('toGeminiRequest', () => {
  it('lifts system text, converts images and pairs tool results with their calls', async () => {
    const request = await toGeminiRequest([
      { role: 'system', content: 'Be brief.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', url: 'data:image/png;base64,AAAA' },
          { type: 'image', url: 'https://example.com/cat.jpg' },
        ],
      },
      { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{"q":"cat"}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'a cat' },
      { role: 'tool', toolCallId: 'gemini-call-2', content: 'nope', isError: true },
      { role: 'user', content: 'Thanks' },
    ], {
      tools: [{ name: 'lookup', description: 'Look up', parameters: { properties: { q: { type: 'string' } } } }],
      maxTokens: 100,
      temperature: 0.2,
      download: async () => ({ mimeType: 'image/jpeg', data: 'BBBB' }),
    })
    expect(request).toEqual({
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'What is this?' },
            { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
            { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } },
          ],
        },
        { role: 'model', parts: [{ text: 'Looking.' }, { functionCall: { id: 'c1', name: 'lookup', args: { q: 'cat' } } }] },
        {
          role: 'user',
          parts: [
            { functionResponse: { id: 'c1', name: 'lookup', response: { result: 'a cat' } } },
            { functionResponse: { name: 'gemini-call-2', response: { error: 'nope' } } },
            { text: 'Thanks' },
          ],
        },
      ],
      tools: [{ functionDeclarations: [{ name: 'lookup', description: 'Look up', parametersJsonSchema: { type: 'object', properties: { q: { type: 'string' } } } }] }],
      generationConfig: { maxOutputTokens: 100, temperature: 0.2 },
    })
  })

  it('replays raw turns verbatim, thought signatures included', async () => {
    const parts = [{ functionCall: { name: 'lookup', args: {} }, thoughtSignature: 'sig' }]
    const { contents } = await toGeminiRequest([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'gemini-call-1', name: 'lookup', arguments: '{}' }], raw: { type: 'gemini', content: parts } },
      { role: 'tool', toolCallId: 'gemini-call-1', content: 'ok' },
    ])
    expect(contents[1]).toEqual({ role: 'model', parts })
    expect(contents[2].parts[0]).toEqual({ functionResponse: { name: 'lookup', response: { result: 'ok' } } })
  })
})

describe('fromResponse', () => {
  it('reads text, function calls, usage and keeps the parts as the raw turn', () => {
    const parts = [
      { text: 'thinking', thought: true },
      { text: 'Let me check.' },
      { functionCall: { name: 'lookup', args: { q: 1 } }, thoughtSignature: 'sig' },
    ]
    const response = fromResponse({
      candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
    })
    expect(response).toEqual({
      text: 'Let me check.',
      toolCalls: [{ id: 'gemini-call-1', name: 'lookup', arguments: '{"q":1}' }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 10, outputTokens: 8 },
      raw: { type: 'gemini', content: parts },
    })
  })

  it('maps finish reasons and blocked prompts', () => {
    expect(fromResponse({ candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: 'MAX_TOKENS' }] }).finishReason).toBe('length')
    expect(fromResponse({ candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: 'SAFETY' }] }).finishReason).toBe('refusal')
    expect(fromResponse({ candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: 'OTHER' }] }).finishReason).toBe('other')
    expect(fromResponse({ promptFeedback: { blockReason: 'SAFETY' } })).toMatchObject({ text: '', finishReason: 'refusal' })
  })
})

describe('mergeParts', () => {
  it('joins streamed text but keeps signed parts and calls apart', () => {
    const parts = mergeParts([], [{ text: 'Hel' }, { text: 'lo', thoughtSignature: 's1' }, { text: '!' }, { functionCall: { name: 'f' } }])
    expect(parts).toEqual([{ text: 'Hello', thoughtSignature: 's1' }, { text: '!' }, { functionCall: { name: 'f' } }])
  })
})

describe('GeminiClient', () => {
  it('sends generateContent with the key header', async () => {
    const { mock, client: gemini } = client(async () => json({ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }))
    const response = await gemini.chat({ model: 'gemini-test', messages: [{ role: 'user', content: 'hi' }] })
    expect(response.text).toBe('OK')
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent')
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe('key')
    expect(JSON.parse(init!.body as string).contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
  })

  it('streams deltas over SSE and finishes with the merged turn', async () => {
    const { mock, client: gemini } = client(async () => sse([
      { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'lo' }] } }] },
      { candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'sig' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } },
    ]))
    const events = []
    for await (const event of gemini.stream({ model: 'gemini-test', messages: [{ role: 'user', content: 'hi' }] })) events.push(event)
    expect(mock.mock.calls[0][0]).toMatch(/:streamGenerateContent\?alt=sse$/)
    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      {
        type: 'done',
        response: {
          text: 'Hello',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 2, outputTokens: 1 },
          raw: { type: 'gemini', content: [{ text: 'Hello', thoughtSignature: 'sig' }] },
        },
      },
    ])
  })

  it('throws the API error message with its status', async () => {
    const { client: gemini } = client(async () => json({ error: { code: 400, message: 'API key not valid' } }, 400))
    await expect(gemini.chat({ model: 'm', messages: [] })).rejects.toMatchObject({ status: 400, message: 'Gemini API 400: API key not valid' })
  })

  it('lists only models that can generate content, across pages', async () => {
    const { client: gemini } = client(async (url) => url.includes('pageToken')
      ? json({ models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }] })
      : json({
        models: [
          { name: 'models/gemini-c', supportedGenerationMethods: ['generateContent', 'countTokens'] },
          { name: 'models/text-embedding', supportedGenerationMethods: ['embedContent'] },
        ],
        nextPageToken: 'next',
      }))
    expect(await gemini.listModels()).toEqual(['gemini-b', 'gemini-c'])
  })

  it('embeds texts with batchEmbedContents', async () => {
    const { mock, client: gemini } = client(async () => json({ embeddings: [{ values: [1, 2] }, { values: [3, 4] }] }))
    expect(await gemini.embed({ model: 'gemini-embedding', input: ['a', 'b'] })).toEqual({ vectors: [[1, 2], [3, 4]] })
    const [url, init] = mock.mock.calls[0]
    expect(url).toMatch(/models\/gemini-embedding:batchEmbedContents$/)
    expect(JSON.parse(init!.body as string).requests[1]).toEqual({ model: 'models/gemini-embedding', content: { parts: [{ text: 'b' }] } })
  })
})
