import { describe, expect, it, vi } from 'vitest'
import { describeDetail, ProviderConfig, TypeSafeClient } from '../src'

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function client(response: () => Response, config: Partial<ProviderConfig> = {}) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response())
  return { fetch, client: new TypeSafeClient(ProviderConfig.parse({ apiKey: 'ts-key', ...config }), fetch as unknown as typeof globalThis.fetch) }
}

const answers = {
  happy: { type: 'noul', noul: 0.98 },
  topic: { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: { billing: 0.9, other: 0.1 } },
  tone: { type: 'score', score: 1.7, confidence: 0.6, legend: { 0: 'calm', 1: 'tense', 2: 'angry' }, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } },
}

describe('TypeSafeClient.decide', () => {
  it('posts questions to /v1/systemone and normalizes usage', async () => {
    const { fetch, client: jev } = client(() => json({ model: 'jev-1.14.0', answers, usage: { input_tokens: 40, output_tokens: 3 } }))
    const response = await jev.decide({
      model: 'jev-latest',
      state: { messages: ['I was charged twice'] },
      questions: {
        happy: { type: 'noul', criteria: { true: 'satisfied', false: 'not satisfied' } },
        topic: { type: 'choice', criteria: { billing: 'Payments', other: 'Anything else' } },
        tone: { type: 'score', instructions: 'Rate the tone', criteria: ['calm', 'tense', 'angry'] },
      },
    })
    expect(response).toEqual({ answers, usage: { inputTokens: 40, outputTokens: 3 } })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    const headers = init!.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer ts-key')
    expect(headers).not.toHaveProperty('TypeSafe-Danger-Zone-Images')
    expect(headers).not.toHaveProperty('TypeSafe-Danger-Zone-Long-Context')
    expect(JSON.parse(init!.body as string)).toEqual({
      model: 'jev-latest',
      state: { messages: ['I was charged twice'] },
      questions: {
        happy: { type: 'noul', criteria: { true: 'satisfied', false: 'not satisfied' } },
        topic: { type: 'choice', criteria: { billing: 'Payments', other: 'Anything else' } },
        tone: { type: 'score', instructions: 'Rate the tone', criteria: ['calm', 'tense', 'angry'] },
      },
    })
  })

  it('sends assets as data_base64 with the images and long-context headers', async () => {
    const { fetch, client: jev } = client(() => json({ answers: { where: { type: 'box', box: { top: 1, bottom: 2, left: 3, right: 4 }, confidence: null } } }), { longContext: true })
    const response = await jev.decide({
      model: 'jev-latest',
      state: 'Find the cat in {photo}',
      questions: { where: { type: 'box' } },
      assets: { photo: { type: 'image', format: 'png', data: 'AAAA' } },
    })
    expect(response.answers.where).toEqual({ type: 'box', box: { top: 1, bottom: 2, left: 3, right: 4 }, confidence: null })
    const init = fetch.mock.calls[0][1]!
    expect(init.headers).toMatchObject({ 'TypeSafe-Danger-Zone-Images': 'true', 'TypeSafe-Danger-Zone-Long-Context': 'true' })
    expect(JSON.parse(init.body as string).assets).toEqual({ photo: { type: 'image', format: 'png', data_base64: 'AAAA' } })
  })

  it('uses the OpenRouter base URL as given', async () => {
    const { fetch, client: jev } = client(() => json({ answers: {} }), { baseURL: 'https://openrouter.ai/api/' })
    await jev.decide({ model: 'typesafe/jev-1.13', state: 'x', questions: { ok: { type: 'noul' } } })
    expect(fetch.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/systemone')
  })
})

describe('TypeSafe errors', () => {
  it('reports 422 validation details with their locations', async () => {
    const { client: jev } = client(() => json({ detail: [{ loc: ['body', 'questions', 'tone', 'criteria'], msg: 'too many items', type: 'too_long' }] }, 422))
    await expect(jev.decide({ model: 'jev-latest', state: 'x', questions: {} })).rejects.toMatchObject({
      status: 422,
      message: 'TypeSafe API 422: body.questions.tone.criteria: too many items',
    })
  })

  it('reports 429 with retry-after and 529 as overloaded', async () => {
    const limited = client(() => json({ detail: 'slow down' }, 429, { 'retry-after': '7' })).client
    await expect(limited.decide({ model: 'm', state: 'x', questions: {} })).rejects.toMatchObject({
      status: 429,
      retryAfter: 7,
      message: 'TypeSafe API 429: rate limited: slow down (retry after 7s)',
    })
    const overloaded = client(() => new Response('', { status: 529 })).client
    await expect(overloaded.decide({ model: 'm', state: 'x', questions: {} })).rejects.toMatchObject({ status: 529, message: 'TypeSafe API 529: the service is overloaded' })
  })

  it('formats object details as JSON', () => {
    expect(describeDetail({ field: 'state' })).toBe('{"field":"state"}')
  })

  it('refuses to chat', async () => {
    await expect(client(() => json({})).client.chat()).rejects.toThrow(/decisions only/)
  })
})

describe('TypeSafeClient.listModels', () => {
  it('returns the model aliases', async () => {
    const { fetch, client: jev } = client(() => json({ models: [{ name: 'jev-latest', description: 'Latest', release_date: '2026-01-01' }, { name: 'jev-preview' }] }))
    expect(await jev.listModels()).toEqual(['jev-latest', 'jev-preview'])
    expect(fetch.mock.calls[0][0]).toBe('https://api.typesafe.ai/v1/models')
  })
})
