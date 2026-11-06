import { describe, expect, it, vi } from 'vitest'
import { AzureConfig, OpenAIClient, ProviderConfig } from '../src'

const completion = {
  id: 'c', object: 'chat.completion', created: 0, model: 'gpt',
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
}

function azure(config: Partial<AzureConfig>) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(completion), { headers: { 'content-type': 'application/json' } }))
  const client = OpenAIClient.fromAzure(AzureConfig.parse({ endpoint: 'https://res.openai.azure.com', apiKey: 'k', ...config }), fetch as unknown as typeof globalThis.fetch)
  return { fetch, client }
}

describe('azure-openai', () => {
  it('sends chat to the configured deployment with the api version and key header', async () => {
    const { fetch, client } = azure({ deployment: 'prod-gpt', apiVersion: '2024-10-21' })
    const response = await client.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 })
    expect(response).toMatchObject({ text: 'OK', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 1 } })
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe('https://res.openai.azure.com/openai/deployments/prod-gpt/chat/completions?api-version=2024-10-21')
    expect(new Headers(init!.headers).get('api-key')).toBe('k')
    expect(JSON.parse(init!.body as string)).toMatchObject({ max_completion_tokens: 50 })
  })

  it('uses the model name as the deployment when none is set', async () => {
    const { fetch, client } = azure({})
    await client.chat({ model: 'my-deploy', messages: [{ role: 'user', content: 'hi' }] })
    expect(String(fetch.mock.calls[0][0])).toContain('/openai/deployments/my-deploy/chat/completions')
  })
})

describe('OpenAIClient.fromConfig', () => {
  it('sends max_tokens to compatible services and max_completion_tokens to OpenAI', () => {
    const request = { model: 'm', messages: [], maxTokens: 9 }
    expect(OpenAIClient.fromConfig(ProviderConfig.parse({ baseURL: 'https://api.deepseek.com/v1' })).params(request)).toMatchObject({ max_tokens: 9 })
    expect(OpenAIClient.fromConfig(ProviderConfig.parse({})).params(request)).toMatchObject({ max_completion_tokens: 9 })
  })
})
