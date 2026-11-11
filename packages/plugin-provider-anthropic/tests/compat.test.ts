import { describe, expect, it } from 'vitest'
import type { ProviderType } from '@mushinjs/plugin-providers'
import { AnthropicClient, apply, ProviderConfig } from '../src'

const request = {
  model: 'claude-opus-5-5',
  messages: [{ role: 'user' as const, content: 'hi' }],
  tools: [{ name: 'look', description: 'Look', parameters: { type: 'object', properties: {} } }],
}

function params(baseURL: string, streaming: boolean) {
  const client = new AnthropicClient(ProviderConfig.parse({ apiKey: 'k', baseURL }))
  return (client as any).params(request, streaming)
}

describe('Anthropic-compatible endpoints', () => {
  it('get no refusal-fallback beta and no eager input streaming', () => {
    for (const baseURL of ['https://api.deepseek.com/anthropic', 'https://api.moonshot.cn/anthropic']) {
      const { fallback, body } = params(baseURL, true)
      expect(fallback).toBe(false)
      expect(body.tools[0]).not.toHaveProperty('eager_input_streaming')
    }
  })

  it('still get both on the official API', () => {
    const { fallback, body } = params('https://api.anthropic.com', true)
    expect(fallback).toBe(true)
    expect(body.tools[0].eager_input_streaming).toBe(true)
  })

  it('have presets with valid configs', () => {
    const types: ProviderType[] = []
    apply({ llm: { defineType: (type: ProviderType) => types.push(type) } } as any)
    const presets = types[0].presets ?? []
    expect(presets.map((preset) => preset.id)).toEqual(['anthropic', 'deepseek-anthropic', 'moonshot-anthropic', 'zhipu-anthropic', 'minimax-anthropic'])
    for (const preset of presets) {
      expect(ProviderConfig.safeParse({ apiKey: 'k', ...preset.config }).success, preset.id).toBe(true)
    }
  })
})
